package org.veritybench.flowcarbon;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Saves what the page offers for download (CSV exports, the import template) into the phone's Downloads folder,
 * fetched by the app itself with the person's session. It does not use the system download manager, whose background
 * jobs phone makers' power managers can hold back indefinitely. The result is reported to the page ({@link Report}),
 * which can then open the file ({@link #openLast}).
 */
final class Downloads {
    /** what the page is told: "started", "saved", "failed" or "noapp", the file's name, and whether it can be opened */
    interface Report {
        void send(String state, String name, boolean canOpen);
    }

    private final Activity activity;
    private final Report report;
    private volatile Uri last;
    private volatile String lastType;

    Downloads(Activity activity, Report report) {
        this.activity = activity;
        this.report = report;
    }

    void save(String url, String userAgent, String contentDisposition, String mimeType) {
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        report.send("started", name, false);
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15_000);
                c.setReadTimeout(60_000);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) c.setRequestProperty("Cookie", cookie); // exports need the session
                if (userAgent != null) c.setRequestProperty("User-Agent", userAgent);
                int code = c.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
                String type = mimeType != null && !mimeType.isEmpty() ? mimeType : c.getContentType();
                try (InputStream in = c.getInputStream()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveToMediaStore(in, name, type);
                    else saveToFolder(in, name, type);
                }
                report.send("saved", name, last != null);
            } catch (IOException | RuntimeException e) {
                report.send("failed", name, false);
            } finally {
                if (c != null) c.disconnect();
            }
        }, "flowcarbon-download").start();
    }

    /** Android 10 and later: into Downloads through the media store, which needs no permission. */
    @TargetApi(Build.VERSION_CODES.Q)
    private void saveToMediaStore(InputStream in, String name, String type) throws IOException {
        ContentResolver resolver = activity.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        if (type != null) values.put(MediaStore.Downloads.MIME_TYPE, type);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("no room in Downloads");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("Downloads is not writable");
            copy(in, out);
        } catch (IOException | RuntimeException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        last = uri;
        lastType = type;
    }

    /** Android 8–9: into the Downloads folder (the app asked for the storage permission first). */
    private void saveToFolder(InputStream in, String name, String type) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        for (int i = 1; file.exists(); i++)
            file = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + i + ")" + name.substring(dot) : name + " (" + i + ")");
        try (OutputStream out = new FileOutputStream(file)) {
            copy(in, out);
        }
        MediaScannerConnection.scanFile(activity, new String[] {file.getPath()}, new String[] {type}, null);
        // opening a file path from another app needs a file provider; the person finds it in Downloads instead
        last = null;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
    }

    /** Opens the file saved last with an app that can show it. */
    void openLast() {
        if (last == null) return;
        Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(last, lastType)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            activity.startActivity(view);
        } catch (ActivityNotFoundException e) {
            report.send("noapp", "", false);
        }
    }
}
