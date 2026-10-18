package org.veritybench.flowcarbon;

import android.animation.ObjectAnimator;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The brand stage in front of the web view: the launch intro (the mark assembles, the wordmark settles, a sweep
 * runs until the first page is ready) and the offline screen. It leaves by lifting the mark away while the page
 * underneath fades and settles into place.
 */
final class StageView extends FrameLayout {
    private final LogoMarkView mark;
    private final TextView wordmark;
    private final TextView tagline;
    private final ProgressLine sweep;
    private final LinearLayout offline;
    private final TextView offlineTitle;
    private final TextView offlineBody;
    private final TextView retry;
    private final TextView version;
    private final GradientDrawable glow;
    private boolean offlineShown;
    private Runnable onRetry;

    StageView(Context context, String versionName) {
        super(context);
        GradientDrawable base = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {0xFF0B2A27, 0xFF06171A, 0xFF040D0F});
        glow = new GradientDrawable();
        glow.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        glow.setColors(new int[] {0x402FD4BD, 0x142FD4BD, 0x002FD4BD});
        glow.setGradientCenter(0.5f, 0.42f);
        setBackground(new LayerDrawable(new Drawable[] {base, glow}));
        setClickable(true); // nothing behind the stage reacts to touches while it is up

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        addView(column, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        mark = new LogoMarkView(context);
        column.addView(mark, new LinearLayout.LayoutParams(dp(92), dp(92)));

        wordmark = text(context, 32, 0xFFE9FBF7, Typeface.create("sans-serif-medium", Typeface.NORMAL));
        wordmark.setText(R.string.app_name);
        wordmark.setLetterSpacing(0.02f);
        column.addView(wordmark, spaced(dp(22)));

        tagline = text(context, 14, 0xFF8FB3AC, Typeface.create("sans-serif", Typeface.NORMAL));
        tagline.setText(R.string.tagline);
        tagline.setLetterSpacing(0.06f);
        column.addView(tagline, spaced(dp(8)));

        sweep = new ProgressLine(context);
        LinearLayout.LayoutParams sweepLp = new LinearLayout.LayoutParams(dp(132), dp(3));
        sweepLp.topMargin = dp(34);
        column.addView(sweep, sweepLp);

        offline = new LinearLayout(context);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER_HORIZONTAL);
        offline.setVisibility(GONE);
        column.addView(offline, spaced(dp(26)));

        offlineTitle = text(context, 19, 0xFFE9FBF7, Typeface.create("sans-serif-medium", Typeface.NORMAL));
        offline.addView(offlineTitle);
        offlineBody = text(context, 14, 0xFF8FB3AC, Typeface.create("sans-serif", Typeface.NORMAL));
        offlineBody.setLineSpacing(0, 1.35f);
        offlineBody.setMaxWidth(dp(300));
        offline.addView(offlineBody, spaced(dp(10)));

        retry = text(context, 15, 0xFF04201D, Typeface.create("sans-serif-medium", Typeface.NORMAL));
        retry.setText(R.string.retry);
        retry.setPadding(dp(30), dp(13), dp(30), dp(13));
        retry.setBackground(pill());
        retry.setFocusable(true);
        retry.setClickable(true);
        retry.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            if (onRetry != null) onRetry.run();
        });
        offline.addView(retry, spaced(dp(26)));

        version = text(context, 11, 0x668FB3AC, Typeface.create("sans-serif", Typeface.NORMAL));
        version.setText("v" + versionName);
        version.setLetterSpacing(0.12f);
        addView(version, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        glow.setGradientRadius(Math.max(w, h) * 0.55f);
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        super.onLayout(changed, l, t, r, b);
        // a soft light-to-teal sheen across the wordmark
        float w = wordmark.getWidth();
        if (w > 0) {
            wordmark.getPaint().setShader(new LinearGradient(0, 0, w, 0,
                    new int[] {0xFFF2FFFC, 0xFFBFF8EE, 0xFF5FF0D9}, null, Shader.TileMode.CLAMP));
        }
    }

    /** Keeps the version label clear of the navigation bar. */
    void setInsets(int top, int bottom) {
        LayoutParams lp = (LayoutParams) version.getLayoutParams();
        lp.bottomMargin = bottom + dp(18);
        version.setLayoutParams(lp);
        setPadding(0, top, 0, bottom);
    }

    /** The launch choreography; returns when its last element has arrived. */
    long playIntro() {
        offlineShown = false;
        offline.setVisibility(GONE);
        setAlpha(1f);
        setVisibility(VISIBLE);
        glow.setAlpha(0);
        ObjectAnimator g = ObjectAnimator.ofInt(glow, "alpha", 0, 255);
        g.setDuration(1100);
        g.setInterpolator(Motion.STANDARD);
        g.start();

        long markDone = mark.rise(120);
        enter(wordmark, 440, 14);
        ObjectAnimator spacing = ObjectAnimator.ofFloat(wordmark, "letterSpacing", 0.16f, 0.02f);
        spacing.setStartDelay(440);
        spacing.setDuration(900);
        spacing.setInterpolator(Motion.ENTER);
        spacing.start();
        enter(tagline, 640, 8);
        enter(version, 800, 0);
        sweep.setAlpha(0f);
        sweep.animate().alpha(1f).setStartDelay(880).setDuration(Motion.MEDIUM).setInterpolator(Motion.STANDARD).start();
        sweep.sweep();
        postDelayed(mark::breathe, markDone);
        return Math.max(markDone, 1100);
    }

    /** Offline or the server is down. Safe to call repeatedly. */
    void showOffline(boolean serverDown, Runnable retryAction) {
        onRetry = retryAction;
        offlineTitle.setText(serverDown ? R.string.server_title : R.string.offline_title);
        offlineBody.setText(serverDown ? R.string.server_body : R.string.offline_body);
        if (getVisibility() != VISIBLE || getAlpha() < 1f) {
            setVisibility(VISIBLE);
            animate().cancel();
            setAlpha(0f);
            animate().alpha(1f).setStartDelay(0).setDuration(Motion.MEDIUM).setInterpolator(Motion.STANDARD).start();
            glow.setAlpha(255);
            wordmark.setAlpha(1f);
        }
        if (offlineShown) return;
        offlineShown = true;
        sweep.stopAll();
        leave(tagline, 0);
        leave(sweep, 0);
        mark.drift();
        offline.setVisibility(VISIBLE);
        offline.setAlpha(1f);
        enter(offlineTitle, 120, 10);
        enter(offlineBody, 190, 10);
        enter(retry, 260, 10);
    }

    /** Retry pressed while online again: back to the loading state. */
    void showLoading() {
        if (!offlineShown) return;
        offlineShown = false;
        leave(offlineTitle, 0);
        leave(offlineBody, 30);
        leave(retry, 60);
        postDelayed(() -> {
            if (!offlineShown) offline.setVisibility(GONE);
        }, Motion.MEDIUM);
        mark.settle();
        mark.breathe();
        enter(tagline, 160, 6);
        sweep.setAlpha(0f);
        sweep.animate().alpha(1f).setStartDelay(160).setDuration(Motion.MEDIUM).setInterpolator(Motion.STANDARD).start();
        sweep.sweep();
    }

    /** Still offline after a retry: a small refusal shake. */
    void refuse() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) retry.performHapticFeedback(HapticFeedbackConstants.REJECT);
        if (!Motion.enabled()) return;
        float d = dp(7);
        ObjectAnimator shake = ObjectAnimator.ofFloat(retry, "translationX", 0, -d, d, -d * 0.6f, d * 0.6f, -d * 0.25f, 0);
        shake.setDuration(420);
        shake.start();
    }

    boolean isUp() {
        return getVisibility() == VISIBLE;
    }

    boolean isOffline() {
        return offlineShown && isUp();
    }

    /** Leave, revealing {@code page}: the mark lifts away, the stage dissolves, the page settles in. */
    void reveal(View page, Runnable done) {
        mark.stopLoop();
        sweep.stopAll();
        mark.animate().translationY(-dp(14)).scaleX(1.08f).scaleY(1.08f).alpha(0f)
                .setStartDelay(0).setDuration(380).setInterpolator(Motion.EXIT).start();
        for (View v : new View[] {wordmark, tagline, sweep, offline, version}) {
            v.animate().alpha(0f).translationY(-dp(6)).setStartDelay(40).setDuration(300)
                    .setInterpolator(Motion.EXIT).start();
        }
        page.setScaleX(0.985f);
        page.setScaleY(0.985f);
        page.animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(140).setDuration(560)
                .setInterpolator(Motion.ENTER).start();
        animate().alpha(0f).setStartDelay(160).setDuration(460).setInterpolator(Motion.STANDARD)
                .withEndAction(() -> {
                    setVisibility(GONE);
                    resetChildren();
                    offlineShown = false;
                    offline.setVisibility(GONE);
                    if (done != null) done.run();
                })
                .start();
    }

    private void resetChildren() {
        for (View v : new View[] {mark, wordmark, tagline, sweep, offline, version, offlineTitle, offlineBody, retry}) {
            v.animate().cancel();
            v.setTranslationY(0);
            v.setTranslationX(0);
            v.setAlpha(1f);
        }
        mark.setScaleX(1f);
        mark.setScaleY(1f);
        mark.settle();
    }

    private void enter(View v, long delay, int riseDp) {
        v.animate().cancel();
        v.setAlpha(0f);
        v.setTranslationY(dp(riseDp));
        v.animate().alpha(1f).translationY(0).setStartDelay(delay).setDuration(Motion.LONG)
                .setInterpolator(Motion.ENTER).start();
    }

    private void leave(View v, long delay) {
        v.animate().alpha(0f).translationY(-dp(4)).setStartDelay(delay).setDuration(Motion.SHORT)
                .setInterpolator(Motion.EXIT).start();
    }

    private TextView text(Context context, float sp, int color, Typeface face) {
        TextView t = new TextView(context);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(face);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        return t;
    }

    private RippleDrawable pill() {
        GradientDrawable fill = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[] {0xFF5FF0D9, 0xFF2FD4BD});
        fill.setCornerRadius(dp(26));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(0xFFFFFFFF);
        mask.setCornerRadius(dp(26));
        return new RippleDrawable(ColorStateList.valueOf(0x3304201D), fill, mask);
    }

    private LinearLayout.LayoutParams spaced(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
