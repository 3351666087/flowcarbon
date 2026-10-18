# The page calls the shell through window.FlowCarbonShell; keep the bridge methods by name.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
