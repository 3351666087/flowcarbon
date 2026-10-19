package org.veritybench.flowcarbon;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates the app in place, the same way on any Android phone. The page offers a newer APK (it compares the version
 * in this app's user agent with the published one) and calls {@code FlowCarbonShell.install(url)}.
 *
 * <ol>
 *   <li>If Android does not yet let FlowCarbon install apps, the app opens that system setting itself and carries on
 *       when the person comes back.</li>
 *   <li>The app fetches the APK while it is open, straight into an installer session. It does not use the system
 *       download manager: phone makers' power managers hold its background jobs back, and a download could wait
 *       there forever.</li>
 *   <li>Android asks the person to confirm the install; the app restarts on the new version.</li>
 * </ol>
 *
 * Each step is reported to the page ({@link Report}), because some Android builds hide toasts. Only APKs from the
 * app's own host under /download/ are accepted, and Android only accepts an update signed like the installed app.
 */
final class Updater {
    /** what the page is told: a state, the download's progress (0–1) and, on failure, Android's reason */
    interface Report {
        void send(String state, double progress, String detail);
    }

    static final String ACTION_STATUS = "org.veritybench.flowcarbon.INSTALL_STATUS";

    private final Activity activity;
    private final String scheme;
    private final String host;
    private final Report report;
    /** the update waiting for the install permission, resumed when the person comes back from the setting */
    private String afterPermission;
    private volatile boolean running;

    Updater(Activity activity, String scheme, String host, Report report) {
        this.activity = activity;
        this.scheme = scheme;
        this.host = host;
        this.report = report;
    }

    void start(String url) {
        Uri u = Uri.parse(url);
        String path = u.getPath() == null ? "" : u.getPath();
        if (!scheme.equals(u.getScheme()) || !host.equalsIgnoreCase(u.getHost())
                || !path.startsWith("/download/") || !path.endsWith(".apk")) {
            report.send("failed", 0, "not an update from this app's site");
            return;
        }
        if (running) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            afterPermission = url;
            report.send("permission", 0, null);
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
                return;
            } catch (ActivityNotFoundException e) {
                // a build without that screen: go ahead, and Android asks when the install is committed
                afterPermission = null;
            }
        }
        fetch(url);
    }

    /** Back in the app (from the setting, or anywhere): carry on with an update that was waiting for permission. */
    void resumed() {
        if (afterPermission == null) return;
        String url = afterPermission;
        afterPermission = null;
        if (activity.getPackageManager().canRequestPackageInstalls()) fetch(url);
        else report.send("denied", 0, null);
    }

    private void fetch(String url) {
        running = true;
        report.send("downloading", 0, null);
        new Thread(() -> {
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            int sessionId = -1;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15_000);
                c.setReadTimeout(30_000);
                // the APK must come from this app's own host, so a redirect elsewhere is refused
                c.setInstanceFollowRedirects(false);
                int code = c.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
                long total = c.getContentLengthLong();

                PackageInstaller.SessionParams params =
                        new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(activity.getPackageName());
                if (total > 0) params.setSize(total);
                sessionId = installer.createSession(params);
                try (PackageInstaller.Session session = installer.openSession(sessionId);
                        InputStream in = c.getInputStream();
                        OutputStream out = session.openWrite("base.apk", 0, total > 0 ? total : -1)) {
                    byte[] buffer = new byte[64 * 1024];
                    long done = 0;
                    long told = 0;
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        out.write(buffer, 0, n);
                        done += n;
                        long now = SystemClock.uptimeMillis();
                        if (total > 0 && now - told > 120) {
                            told = now;
                            report.send("downloading", Math.min(1, (double) done / total), null);
                        }
                    }
                    session.fsync(out);
                }
                try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                    Intent status = new Intent(activity, MainActivity.class).setAction(ACTION_STATUS);
                    // the installer fills in the result, so the intent has to stay mutable
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT
                            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent reply = PendingIntent.getActivity(activity, sessionId, status, flags);
                    session.commit(reply.getIntentSender());
                }
                report.send("confirm", 1, null);
            } catch (IOException | RuntimeException e) {
                if (sessionId != -1) {
                    try {
                        installer.abandonSession(sessionId);
                    } catch (RuntimeException ignored) {
                        // already gone
                    }
                }
                report.send("failed", 0, e.getMessage());
            } finally {
                if (c != null) c.disconnect();
                running = false;
            }
        }, "flowcarbon-update").start();
    }

    /**
     * The installer's answer, delivered to the activity: show Android's confirmation, or say what went wrong. Returns
     * false for any other intent.
     */
    @SuppressWarnings("deprecation")
    boolean handle(Intent intent) {
        if (intent == null || !ACTION_STATUS.equals(intent.getAction())) return false;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) {
                report.send("failed", 0, null);
                return true;
            }
            try {
                activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                report.send("confirm", 1, null);
            } catch (RuntimeException e) {
                report.send("failed", 0, e.getMessage());
            }
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            report.send("cancelled", 0, null);
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            report.send("failed", 0, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
        return true;
    }
}
