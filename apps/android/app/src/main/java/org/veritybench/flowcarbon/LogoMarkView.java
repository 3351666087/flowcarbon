package org.veritybench.flowcarbon;

import android.animation.Animator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.os.Build;
import android.view.View;

/**
 * The FlowCarbon mark — three stacked floors — drawn as strokes so each floor can move on its own: the floors rise
 * into place one after another, then the mark breathes while the app loads, or the floors drift apart and back
 * while it waits for the network.
 */
final class LogoMarkView extends View {
    // glyph in its own units, centred on (0, 0.5): top floor (a rhombus), then two chevrons
    private static final float[][] FLOORS = {
        {0, -10, 11, -4.5f, 0, 1, -11, -4.5f, 0, -10},
        {-11, 0.5f, 0, 6, 11, 0.5f},
        {-11, 5.5f, 0, 11, 11, 5.5f},
    };
    private static final float GLYPH_UNITS = 27f;
    private static final float RISE_UNITS = 7f;

    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path[] paths = {new Path(), new Path(), new Path()};
    /** how far each floor has arrived, 0..1 (index 0 = top floor) */
    private final float[] arrived = {0, 0, 0};
    /** extra spacing between floors, in glyph units (floating while offline) */
    private float spread;
    /** 0..1, intensity of the glow behind the strokes */
    private float glow = 0.6f;
    private float unit = 1;
    private Animator loop;

    LogoMarkView(Context context) {
        super(context);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        // a stroked path's shadow needs a software layer before Android 9
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) setLayerType(LAYER_TYPE_SOFTWARE, null);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        unit = Math.min(w, h) / GLYPH_UNITS;
        Matrix m = new Matrix();
        m.setScale(unit, unit);
        for (int i = 0; i < FLOORS.length; i++) {
            Path p = paths[i];
            p.reset();
            float[] pts = FLOORS[i];
            p.moveTo(pts[0], pts[1]);
            for (int k = 2; k < pts.length; k += 2) p.lineTo(pts[k], pts[k + 1]);
            if (i == 0) p.close();
            p.transform(m);
        }
        stroke.setStrokeWidth(2.2f * unit);
        stroke.setShader(new LinearGradient(0, -10 * unit, 0, 11 * unit,
                0xFF5FF0D9, 0xFF1AA597, Shader.TileMode.CLAMP));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f - 0.5f * unit;
        stroke.setShadowLayer(glow * 6 * unit, 0, 0, 0x8C2FD4BD);
        // bottom floor first, so the upper ones sit on top
        for (int i = FLOORS.length - 1; i >= 0; i--) {
            float a = arrived[i];
            if (a <= 0) continue;
            canvas.save();
            canvas.translate(cx, cy + ((1 - a) * RISE_UNITS + (i - 1) * spread) * unit);
            stroke.setAlpha(Math.round(255 * Math.min(1, a)));
            canvas.drawPath(paths[i], stroke);
            canvas.restore();
        }
    }

    /** Floors rise into place bottom to top; returns the total duration. */
    long rise(long startDelay) {
        stopLoop();
        long stagger = 110;
        long each = Motion.LONG;
        for (int i = FLOORS.length - 1, order = 0; i >= 0; i--, order++) {
            final int floor = i;
            arrived[floor] = 0;
            ValueAnimator a = ValueAnimator.ofFloat(0, 1);
            a.setStartDelay(startDelay + order * stagger);
            a.setDuration(each);
            a.setInterpolator(Motion.ENTER);
            a.addUpdateListener(v -> {
                arrived[floor] = (float) v.getAnimatedValue();
                invalidate();
            });
            a.start();
        }
        if (!Motion.enabled()) settle();
        return startDelay + (FLOORS.length - 1) * stagger + each;
    }

    /** All floors in place, no motion. */
    void settle() {
        stopLoop();
        for (int i = 0; i < arrived.length; i++) arrived[i] = 1;
        spread = 0;
        glow = 0.6f;
        setScaleX(1);
        setScaleY(1);
        invalidate();
    }

    /** Waiting for the app: a slow breath of scale and glow. */
    void breathe() {
        if (!Motion.enabled()) return;
        stopLoop();
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration(1800);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.setRepeatMode(ValueAnimator.REVERSE);
        a.setInterpolator(Motion.SINE);
        a.addUpdateListener(v -> {
            float t = (float) v.getAnimatedValue();
            setScaleX(1 + 0.035f * t);
            setScaleY(1 + 0.035f * t);
            glow = 0.45f + 0.55f * t;
            invalidate();
        });
        loop = a;
        a.start();
    }

    /** Waiting for the network: the floors drift apart and back, like a building taking a breath. */
    void drift() {
        for (int i = 0; i < arrived.length; i++) arrived[i] = 1;
        if (!Motion.enabled()) {
            invalidate();
            return;
        }
        stopLoop();
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration(2400);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.setRepeatMode(ValueAnimator.REVERSE);
        a.setInterpolator(Motion.SINE);
        a.addUpdateListener(v -> {
            float t = (float) v.getAnimatedValue();
            spread = 1.6f * t;
            glow = 0.25f + 0.35f * t;
            invalidate();
        });
        loop = a;
        a.start();
    }

    void stopLoop() {
        if (loop != null) {
            loop.cancel();
            loop = null;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        stopLoop();
        super.onDetachedFromWindow();
    }
}
