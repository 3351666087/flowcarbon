package org.veritybench.flowcarbon;

import android.Manifest;
import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * FlowCarbon for Android: the web app in a native shell. The shell adds what a browser tab cannot: a launch intro
 * that hands over to the first rendered page, system bars that take the page's colour, predictive back, an offline
 * screen that reconnects by itself, and downloads that carry the session.
 */
public final class MainActivity extends Activity {
    /** the intro is never cut shorter than its choreography */
    private static final long MIN_INTRO_MS = 1150;
    /** nor held longer than this once the page has loaded, even if it never reports ready */
    private static final long MAX_READY_WAIT_MS = 5000;
    private static final int REQUEST_STORAGE = 7;
    private static final int REQUEST_FILE = 8;
    private static final Pattern RGB = Pattern.compile("rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)");
    /** reports the page background now and whenever the theme changes */
    private static final String THEME_PROBE = "(function(){"
            + "function report(){try{window.FlowCarbonShell.theme(getComputedStyle(document.body).backgroundColor);}catch(e){}}"
            + "if(!window.__fcShell){window.__fcShell=true;"
            + "new MutationObserver(function(){report();setTimeout(report,360);}).observe(document.documentElement,"
            + "{attributes:true,attributeFilter:['data-theme','class','style']});"
            + "try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){setTimeout(report,60);});}catch(e){}}"
            + "report();})();";
    /**
     * Reports ready once the page shows real content — the sign-in form or the app's navigation — rather than the
     * loading state a client-rendered page passes through first; two frames later, so that content has painted.
     */
    private static final String READY_PROBE = "(function(){"
            + "var S='main form, nav[aria-label=\"Main\"]';"
            + "function done(){requestAnimationFrame(function(){requestAnimationFrame(function(){"
            + "try{window.FlowCarbonShell.ready();}catch(e){}});});}"
            + "if(document.querySelector(S)){done();return;}"
            + "var o=new MutationObserver(function(){if(document.querySelector(S)){o.disconnect();done();}});"
            + "o.observe(document.documentElement,{childList:true,subtree:true});})();";

    private FrameLayout root;
    private WebView web;
    private StageView stage;
    private ProgressLine bar;
    /** system bar insets in CSS pixels, handed to the page as --app-top / --app-bottom */
    private float insetTop;
    private float insetBottom;
    private String appUrl;
    private String appHost;
    private String appScheme;
    private int pageColor;
    private boolean revealed;
    private boolean mainFrameFailed;
    private long introStart;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private OnBackInvokedCallback backCallback;
    private boolean backRegistered;
    /** sheets, dialogs and menus open on the page, as it reports them; back closes those first */
    private int pageOverlays;
    private DownloadManager.Request pendingDownload;
    private String pendingName;
    private Updater updater;
    /** the page's file input waiting for the system picker (a picture, a CSV to import) */
    private ValueCallback<Uri[]> filePicked;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        appUrl = getString(R.string.app_url);
        appHost = Uri.parse(appUrl).getHost();
        appScheme = Uri.parse(appUrl).getScheme();
        updater = new Updater(this, appScheme, appHost);
        pageColor = getColor(isNight() ? R.color.fc_page_dark : R.color.fc_page_light);
        edgeToEdge();

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.fc_stage));
        web = new WebView(this);
        configure(web);
        bar = new ProgressLine(this);
        stage = new StageView(this, versionName());

        int match = ViewGroup.LayoutParams.MATCH_PARENT;
        root.addView(web, new FrameLayout.LayoutParams(match, match));
        root.addView(bar, new FrameLayout.LayoutParams(match, dp(2.5f), Gravity.TOP));
        root.addView(stage, new FrameLayout.LayoutParams(match, match));
        setContentView(root);
        root.setOnApplyWindowInsetsListener(this::applyInsets);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // the system splash is an empty stage-coloured screen; dissolve it into the intro
            getSplashScreen().setOnExitAnimationListener(view -> view.animate().alpha(0f)
                    .setDuration(Motion.SHORT).withEndAction(view::remove).start());
        }
        setUpBack();
        watchNetwork();

        if (saved != null && web.restoreState(saved) != null) {
            revealed = true;
            stage.setVisibility(View.GONE);
            web.setAlpha(1f);
            darkIcons(Color.luminance(pageColor) > 0.5f);
        } else {
            web.setAlpha(0f);
            introStart = SystemClock.uptimeMillis();
            stage.playIntro();
            darkIcons(false);
            if (online()) {
                String link = linkFrom(getIntent());
                web.loadUrl(link != null ? link : appUrl);
            } else {
                mainFrameFailed = true;
                showOffline(false);
            }
        }
    }

    // ---- window ------------------------------------------------------------------------------------------------

    private void edgeToEdge() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams a = w.getAttributes();
            a.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(a);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
    }

    /**
     * The page runs edge to edge, under the status and navigation bars, as native screens do; it learns where the
     * bars are through --app-top and --app-bottom and pads its own header and tab bar. Only the keyboard (and side
     * insets in landscape) take space away from the page.
     */
    private WindowInsets applyInsets(View v, WindowInsets insets) {
        int top;
        int left;
        int right;
        int navBottom;
        int ime;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            top = bars.top;
            left = bars.left;
            right = bars.right;
            navBottom = bars.bottom;
            ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
        } else {
            top = insets.getSystemWindowInsetTop();
            left = insets.getSystemWindowInsetLeft();
            right = insets.getSystemWindowInsetRight();
            navBottom = insets.getStableInsetBottom();
            int all = insets.getSystemWindowInsetBottom();
            ime = all > navBottom ? all : 0;
        }
        FrameLayout.LayoutParams page = (FrameLayout.LayoutParams) web.getLayoutParams();
        page.setMargins(left, 0, right, ime);
        web.setLayoutParams(page);
        float density = getResources().getDisplayMetrics().density;
        insetTop = top / density;
        insetBottom = ime > 0 ? 0 : navBottom / density;
        pushInsets();
        FrameLayout.LayoutParams progress = (FrameLayout.LayoutParams) bar.getLayoutParams();
        progress.topMargin = top;
        bar.setLayoutParams(progress);
        stage.setInsets(top, navBottom);
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
    }

    private void pushInsets() {
        if (web == null) return;
        web.evaluateJavascript(String.format(java.util.Locale.ROOT,
                "(function(s){s.setProperty('--app-top','%.1fpx');s.setProperty('--app-bottom','%.1fpx');})"
                        + "(document.documentElement.style)", insetTop, insetBottom), null);
    }

    /** Dark status and navigation icons for light pages, light icons for dark pages and the stage. */
    private void darkIcons(boolean dark) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            c.setSystemBarsAppearance(dark ? mask : 0, mask);
        } else {
            View d = getWindow().getDecorView();
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int flags = d.getSystemUiVisibility();
            d.setSystemUiVisibility(dark ? flags | mask : flags & ~mask);
        }
    }

    /** The page reported its background: the web view's own background (seen while it repaints) follows it. */
    private void setPageColor(int color) {
        if (color == pageColor) return;
        int from = pageColor;
        pageColor = color;
        ValueAnimator a = ValueAnimator.ofArgb(from, color);
        a.setDuration(Motion.MEDIUM);
        a.setInterpolator(Motion.STANDARD);
        a.addUpdateListener(v -> web.setBackgroundColor((int) v.getAnimatedValue()));
        a.start();
        if (revealed && !stage.isUp()) darkIcons(Color.luminance(color) > 0.5f);
    }

    // ---- web view ----------------------------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " FlowCarbonAndroid/" + versionName());
        CookieManager.getInstance().setAcceptCookie(true);
        w.setBackgroundColor(pageColor);
        // the page draws its own pull-to-refresh and edges; a browser-style stretch on top of that would fight it
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.setWebViewClient(new Client());
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (revealed) bar.report(progress);
            }

            /** a file input opens the system picker for the types it accepts */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePicked != null) filePicked.onReceiveValue(null);
                filePicked = callback;
                try {
                    startActivityForResult(pickerFor(params), REQUEST_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePicked = null;
                    return false;
                }
            }
        });
        w.setDownloadListener(this::download);
        w.addJavascriptInterface(new Bridge(), "FlowCarbonShell");
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (appScheme.equals(u.getScheme()) && appHost.equalsIgnoreCase(u.getHost())) return false;
            openElsewhere(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            pageOverlays = 0;
            if (revealed && !stage.isUp()) bar.begin();
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            pushInsets();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pushInsets();
            bar.finish();
            view.evaluateJavascript(THEME_PROBE, null);
            updateBack();
            if (!mainFrameFailed && stage.isUp() && !stage.isOffline()) {
                view.evaluateJavascript(READY_PROBE, null);
                root.removeCallbacks(revealAnyway);
                root.postDelayed(revealAnyway, MAX_READY_WAIT_MS);
            }
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updateBack();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            mainFrameFailed = true;
            showOffline(false);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame() || response.getStatusCode() < 500) return;
            mainFrameFailed = true;
            showOffline(true);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // the renderer crashed or was reclaimed: start over with a fresh web view
            root.removeView(web);
            web.destroy();
            web = null;
            recreate();
            return true;
        }
    }

    /** Called by the page: THEME_PROBE, READY_PROBE, and the web app's own controls. */
    private final class Bridge {
        @JavascriptInterface
        public void theme(String css) {
            int color = parseColor(css);
            if (color != 0) runOnUiThread(() -> setPageColor(color));
        }

        /** the page has this many layers open (see apps/web/src/lib/back.ts) */
        @JavascriptInterface
        public void overlays(int n) {
            runOnUiThread(() -> {
                pageOverlays = Math.max(0, n);
                updateBack();
            });
        }

        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                root.removeCallbacks(revealAnyway);
                if (!mainFrameFailed && stage.isUp() && !stage.isOffline()) revealSoon();
            });
        }

        /** a light tick, e.g. as a finger slides across the tab bar */
        /** installs a newer APK in place (see Updater); the page decides when to offer it */
        @JavascriptInterface
        public void install(String url) {
            runOnUiThread(() -> updater.start(url));
        }

        @JavascriptInterface
        public void haptic() {
            feel("tick");
        }

        /** tick (selection moves), confirm (something succeeded), reject (a refusal), press (a firm tap) */
        @JavascriptInterface
        public void feel(String kind) {
            int effect;
            switch (kind == null ? "" : kind) {
                case "confirm":
                    effect = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
                    break;
                case "reject":
                    effect = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                    break;
                case "press":
                    effect = HapticFeedbackConstants.VIRTUAL_KEY;
                    break;
                default:
                    effect = HapticFeedbackConstants.CLOCK_TICK;
            }
            runOnUiThread(() -> {
                if (web != null) web.performHapticFeedback(effect);
            });
        }
    }

    private final Runnable revealAnyway = () -> {
        if (!mainFrameFailed && stage.isUp() && !stage.isOffline()) revealSoon();
    };

    private static int parseColor(String css) {
        if (css == null) return 0;
        Matcher m = RGB.matcher(css);
        if (!m.find()) return 0;
        String alpha = m.group(4);
        if (alpha != null && Float.parseFloat(alpha) < 0.5f) return 0; // transparent body: keep the current colour
        return Color.rgb(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
    }

    /** A link to this app's own site (an App Link from an email, a launcher shortcut), or null. */
    private String linkFrom(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        return appScheme.equals(data.getScheme()) && appHost.equalsIgnoreCase(data.getHost()) ? data.toString() : null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (updater.handle(intent)) return;
        setIntent(intent);
        String link = linkFrom(intent);
        if (link != null && web != null && !stage.isOffline()) web.loadUrl(link);
    }

    private void openElsewhere(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // nothing on the device handles it; staying put is the right answer
        }
    }

    // ---- intro, offline ------------------------------------------------------------------------------------------

    private void revealSoon() {
        long wait = revealed ? 0 : Math.max(0, introStart + MIN_INTRO_MS - SystemClock.uptimeMillis());
        root.postDelayed(this::reveal, wait);
    }

    private void reveal() {
        if (web == null || mainFrameFailed || !stage.isUp() || stage.isOffline()) return;
        revealed = true;
        stage.reveal(web, this::updateBack);
        darkIcons(Color.luminance(pageColor) > 0.5f);
    }

    private void showOffline(boolean serverDown) {
        bar.stopAll();
        bar.animate().cancel();
        bar.setAlpha(0f);
        stage.showOffline(serverDown, this::retry);
        darkIcons(false);
        updateBack();
    }

    private void retry() {
        if (!online()) {
            stage.refuse();
            return;
        }
        mainFrameFailed = false;
        stage.showLoading();
        String current = web.getUrl();
        if (current == null || current.startsWith("about:")) web.loadUrl(appUrl);
        else web.reload();
    }

    private void watchNetwork() {
        connectivity = getSystemService(ConnectivityManager.class);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    if (web != null && stage.isOffline()) retry();
                });
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }

    private boolean online() {
        Network n = connectivity.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : connectivity.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    // ---- back ----------------------------------------------------------------------------------------------------

    private void setUpBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback = this::back;
        }
    }

    /** Back closes the page's topmost sheet or dialog first; with none open it goes back in the page. */
    private void back() {
        if (web == null) return;
        if (pageOverlays > 0) {
            web.evaluateJavascript("window.fcBack ? window.fcBack() : false", handled -> {
                if (!"true".equals(handled) && web.canGoBack()) web.goBack();
                updateBack();
            });
            return;
        }
        if (web.canGoBack()) web.goBack();
        updateBack();
    }

    /** Whether back stays in the app: something is open on the page, or the page has history to go back to. */
    private boolean pageTakesBack() {
        return web != null && !stage.isOffline() && (pageOverlays > 0 || web.canGoBack());
    }

    /**
     * Android 13+: while the page takes back, the callback is registered; otherwise it is unregistered, so the system
     * can show its predictive back-to-home animation.
     */
    private void updateBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || web == null) return;
        boolean want = pageTakesBack();
        OnBackInvokedDispatcher d = getOnBackInvokedDispatcher();
        if (want && !backRegistered) {
            d.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
            backRegistered = true;
        } else if (!want && backRegistered) {
            d.unregisterOnBackInvokedCallback(backCallback);
            backRegistered = false;
        }
    }

    /**
     * Android 8–12 only. From Android 13 the manifest opts into OnBackInvokedCallback (updateBack), and the system
     * no longer calls this method, so predictive back is unaffected.
     */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        if (pageTakesBack()) back();
        else super.onBackPressed();
    }

    // ---- downloads ------------------------------------------------------------------------------------------------

    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) r.addRequestHeader("Cookie", cookie); // CSV exports need the session
        r.addRequestHeader("User-Agent", userAgent);
        r.setMimeType(mimeType);
        r.setTitle(name);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = r;
            pendingName = name;
            requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE);
            return;
        }
        enqueue(r, name);
    }

    private void enqueue(DownloadManager.Request r, String name) {
        try {
            getSystemService(DownloadManager.class).enqueue(r);
            Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * The system picker for a page's file input. WebView's own intent uses the first accept entry as the file type, and
     * ".csv" is not a type, so nothing matched and tapping the button did nothing. Pictures are filtered to images;
     * anything else is offered unfiltered and the page checks what it gets.
     */
    private static Intent pickerFor(WebChromeClient.FileChooserParams params) {
        boolean any = false;
        boolean images = true;
        for (String entry : params.getAcceptTypes()) {
            for (String type : entry.split(",")) {
                String t = type.trim();
                if (t.isEmpty()) continue;
                any = true;
                if (!t.startsWith("image/")) images = false;
            }
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(any && images ? "image/*" : "*/*");
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        return intent;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || filePicked == null) return;
        filePicked.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        filePicked = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_STORAGE || pendingDownload == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) enqueue(pendingDownload, pendingName);
        else Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
        pendingDownload = null;
    }

    // ---- lifecycle -------------------------------------------------------------------------------------------------

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null && revealed) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        updater.release();
        root.removeCallbacks(revealAnyway);
        if (connectivity != null && networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
