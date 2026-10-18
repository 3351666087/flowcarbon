package org.veritybench.flowcarbon;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/**
 * A hairline progress bar with a teal gradient. Determinate mode eases toward each reported value and trickles on
 * its own between reports, so it never sits still or jumps; indeterminate mode sweeps a soft highlight.
 */
final class ProgressLine extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private float shown;
    private float sweep;
    private boolean indeterminate;
    private ValueAnimator ease;
    private ValueAnimator trickle;
    private ValueAnimator sweeper;

    ProgressLine(Context context) {
        super(context);
        setAlpha(0f);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        paint.setShader(new LinearGradient(0, 0, Math.max(w, 1), 0,
                new int[] {0xFF1AA597, 0xFF5FF0D9, 0xFF2FD4BD}, null, Shader.TileMode.CLAMP));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth();
        float h = getHeight();
        float r = h / 2f;
        if (indeterminate) {
            paint.setAlpha(46);
            rect.set(0, 0, w, h);
            canvas.drawRoundRect(rect, r, r, paint);
            float len = w * 0.38f;
            float x = -len + (w + len) * sweep;
            paint.setAlpha(255);
            rect.set(Math.max(0, x), 0, Math.min(w, x + len), h);
            if (rect.width() > 0) canvas.drawRoundRect(rect, r, r, paint);
        } else {
            paint.setAlpha(255);
            rect.set(0, 0, w * shown, h);
            if (rect.width() > 0) canvas.drawRoundRect(rect, r, r, paint);
        }
    }

    /** A page load started. */
    void begin() {
        stopAll();
        indeterminate = false;
        shown = 0;
        animate().cancel();
        setAlpha(1f);
        to(0.12f, Motion.MEDIUM);
        startTrickle();
    }

    /** The WebView reported progress (0–100). */
    void report(int percent) {
        if (indeterminate || getAlpha() == 0f) return;
        float target = Math.min(0.94f, percent / 100f);
        if (target > shown) to(target, Motion.MEDIUM);
    }

    /** The page finished: run to the end, then fade out. */
    void finish() {
        if (indeterminate || getAlpha() == 0f) return;
        stopTrickle();
        to(1f, Motion.SHORT);
        animate().alpha(0f).setStartDelay(Motion.SHORT).setDuration(Motion.MEDIUM)
                .setInterpolator(Motion.STANDARD).start();
    }

    /** Endless sweep, for the intro while the first page loads. */
    void sweep() {
        stopAll();
        indeterminate = true;
        if (!Motion.enabled()) {
            sweep = 0.5f;
            invalidate();
            return;
        }
        sweeper = ValueAnimator.ofFloat(0, 1);
        sweeper.setDuration(1300);
        sweeper.setRepeatCount(ValueAnimator.INFINITE);
        sweeper.setInterpolator(Motion.SINE);
        sweeper.addUpdateListener(v -> {
            sweep = (float) v.getAnimatedValue();
            invalidate();
        });
        sweeper.start();
    }

    void stopAll() {
        stopTrickle();
        if (ease != null) ease.cancel();
        if (sweeper != null) sweeper.cancel();
        sweeper = null;
    }

    private void to(float target, long duration) {
        if (ease != null) ease.cancel();
        ease = ValueAnimator.ofFloat(shown, target);
        ease.setDuration(duration);
        ease.setInterpolator(Motion.STANDARD);
        ease.addUpdateListener(v -> {
            shown = (float) v.getAnimatedValue();
            invalidate();
        });
        ease.start();
    }

    /** Creep toward 90 % between reports, slower the closer it gets. */
    private void startTrickle() {
        if (!Motion.enabled()) return;
        trickle = ValueAnimator.ofFloat(0, 1);
        trickle.setDuration(400);
        trickle.setRepeatCount(ValueAnimator.INFINITE);
        trickle.addUpdateListener(v -> {
            if (ease != null && ease.isRunning()) return;
            shown += (0.9f - shown) * 0.012f;
            invalidate();
        });
        trickle.start();
    }

    private void stopTrickle() {
        if (trickle != null) trickle.cancel();
        trickle = null;
    }

    @Override
    protected void onDetachedFromWindow() {
        stopAll();
        super.onDetachedFromWindow();
    }
}
