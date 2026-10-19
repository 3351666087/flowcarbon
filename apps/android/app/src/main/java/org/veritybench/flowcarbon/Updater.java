package org.veritybench.flowcarbon;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Updates the app in place. The page offers a newer APK (it compares the version in this app's user agent with the
 * published one) and calls {@code FlowCarbonShell.install(url)}; the APK is downloaded by the system download manager,
 * with its notification, then handed to Android's package installer, which asks the person to confirm. Only APKs from
 * the app's own host under /download/ are accepted.
 */
final class Updater {
    static final String ACTION_STATUS = "org.veritybench.flowcarbon.INSTALL_STATUS";
    private static final String APK = "application/vnd.android.package-archive";

    private final Activity activity;
    private final String scheme;
    private final String host;
    private long downloadId = -1;
    private BroadcastReceiver receiver;

    Updater(Activity activity, String scheme, String host) {
        this.activity = activity;
        this.scheme = scheme;
        this.host = host;
    }

    void start(String url) {
        Uri u = Uri.parse(url);
        String path = u.getPath() == null ? "" : u.getPath();
        if (!scheme.equals(u.getScheme()) || !host.equalsIgnoreCase(u.getHost())
                || !path.startsWith("/download/") || !path.endsWith(".apk")) return;
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) {
            failed(null);
            return;
        }
        File file = new File(dir, "FlowCarbon-update.apk");
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        try {
            DownloadManager dm = activity.getSystemService(DownloadManager.class);
            DownloadManager.Request r = new DownloadManager.Request(u)
                    .setTitle(activity.getString(R.string.update_title))
                    .setMimeType(APK)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                    .setDestinationUri(Uri.fromFile(file));
            downloadId = dm.enqueue(r);
        } catch (RuntimeException e) {
            failed(e.getMessage());
            return;
        }
        listen(file);
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_LONG).show();
    }

    // both branches pass what their Android version needs; lint does not follow the version check
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private void listen(File file) {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                stopListening();
                if (!succeeded(id)) {
                    failed(null);
                    return;
                }
                new Thread(() -> install(file), "flowcarbon-update").start();
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        // the download manager is another app, so the receiver has to be exported to hear it
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        else activity.registerReceiver(receiver, filter);
    }

    private void stopListening() {
        if (receiver == null) return;
        try {
            activity.unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // already gone
        }
        receiver = null;
    }

    private boolean succeeded(long id) {
        DownloadManager dm = activity.getSystemService(DownloadManager.class);
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return false;
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return status == DownloadManager.STATUS_SUCCESSFUL;
        }
    }

    /** Streams the APK into an installer session; Android answers through {@link #handle}. */
    private void install(File file) {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        try {
            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (InputStream in = new FileInputStream(file);
                        OutputStream out = session.openWrite("base.apk", 0, file.length())) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                    session.fsync(out);
                }
                Intent status = new Intent(activity, MainActivity.class).setAction(ACTION_STATUS);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent reply = PendingIntent.getActivity(activity, sessionId, status, flags);
                session.commit(reply.getIntentSender());
            }
        } catch (IOException | RuntimeException e) {
            activity.runOnUiThread(() -> failed(e.getMessage()));
        }
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
            if (confirm != null) {
                try {
                    activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (RuntimeException e) {
                    failed(e.getMessage());
                }
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
            failed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
        return true;
    }

    private void failed(String detail) {
        String text = activity.getString(R.string.update_failed);
        Toast.makeText(activity, detail == null ? text : text + " (" + detail + ")", Toast.LENGTH_LONG).show();
    }

    void release() {
        stopListening();
    }
}
