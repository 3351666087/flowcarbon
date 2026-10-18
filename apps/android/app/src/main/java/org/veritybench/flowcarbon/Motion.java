package org.veritybench.flowcarbon;

import android.animation.ValueAnimator;
import android.view.animation.Interpolator;
import android.view.animation.PathInterpolator;

/** Easing and timing shared by every animation in the shell (Material 3 motion tokens). */
final class Motion {
    /** Things arriving on screen: fast start, long gentle settle. */
    static final Interpolator ENTER = new PathInterpolator(0.05f, 0.7f, 0.1f, 1f);
    /** Things leaving the screen: gentle start, quick finish. */
    static final Interpolator EXIT = new PathInterpolator(0.3f, 0f, 0.8f, 0.15f);
    /** Things changing in place. */
    static final Interpolator STANDARD = new PathInterpolator(0.2f, 0f, 0f, 1f);
    /** Slow, symmetric loops (breathing, floating). */
    static final Interpolator SINE = new PathInterpolator(0.37f, 0f, 0.63f, 1f);

    static final long SHORT = 200;
    static final long MEDIUM = 420;
    static final long LONG = 620;

    private Motion() {}

    /** False when the user turned animations off (developer options or accessibility). */
    static boolean enabled() {
        return ValueAnimator.areAnimatorsEnabled();
    }
}
