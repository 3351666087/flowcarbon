"use client";

import { useLayoutEffect } from "react";

/** a spring with a little overshoot, as a CSS linear() easing (Chromium 113+, Safari 17.2+, Firefox 112+) */
const SPRING =
  "linear(0, 0.007, 0.029 2.2%, 0.118 4.6%, 0.26 7.3%, 0.457 10.6%, 0.676 14.6%, 0.86 19%, 0.98 23.4%, 1.044 27.9%, 1.068 32.6%, 1.063 37.6%, 1.04 43.5%, 1.012 51.4%, 0.995 61%, 0.993 72.6%, 1.001 92.3%, 1)";

/** Where the selection is now, read from its transform (mid-animation or after a drag). */
function currentOffset(el: HTMLElement, axis: "x" | "y") {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return null;
  const m = new DOMMatrixReadOnly(t);
  return axis === "x" ? m.m41 : m.m42;
}

/**
 * Moves the `.fc-liquid` selection `el` to the child of `box` whose `data-liquid-key` is `active`. It travels on the
 * compositor (a transform animation), so it stays smooth while the main thread is busy rendering the page it is
 * heading to; on the way it stretches along its path and gathers itself on arrival. It lands without travelling on
 * first show and when the container resizes. While `hold` is set the caller is placing it (a drag), and when it is
 * released it springs from wherever the finger left it.
 */
export function useLiquid(
  axis: "x" | "y",
  active: string | null,
  box: HTMLElement | null,
  el: HTMLElement | null,
  hold = false,
) {
  useLayoutEffect(() => {
    if (!box || !el || hold) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const place = (instant: boolean) => {
      const target = active ? box.querySelector<HTMLElement>(`[data-liquid-key="${active}"]`) : null;
      if (!target) {
        el.style.opacity = "0";
        return;
      }
      const pos = axis === "x" ? target.offsetLeft : target.offsetTop;
      const size = axis === "x" ? target.offsetWidth : target.offsetHeight;
      const from = el.style.opacity === "1" ? currentOffset(el, axis) : null;
      for (const a of el.getAnimations()) a.cancel();
      el.dataset.axis = axis;
      el.style.opacity = "1";
      if (axis === "x") el.style.width = `${size}px`;
      else el.style.height = `${size}px`;
      const at = (p: number, stretch = 1) =>
        axis === "x"
          ? `translate3d(${p}px,0,0) scaleX(${stretch})`
          : `translate3d(0,${p}px,0) scaleY(${stretch})`;
      el.style.transform = at(pos);
      if (instant || reduced || from === null || Math.abs(from - pos) < 1) return;
      const stretch = 1 + Math.min(0.32, Math.abs(pos - from) / (size * 5));
      el.animate(
        [
          { transform: at(from) },
          { transform: at((from + pos) / 2, stretch), offset: 0.42 },
          { transform: at(pos) },
        ],
        {
          duration: 520,
          easing: SPRING,
        },
      );
    };

    place(false);
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      place(true);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [axis, active, box, el, hold]);
}
