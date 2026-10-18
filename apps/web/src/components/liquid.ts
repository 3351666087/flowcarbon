"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Moves the `.fc-liquid` selection `el` to the child of `box` whose `data-liquid-key` is `active`. The two edges travel
 * separately (see globals.css), so the selection stretches toward its target and gathers itself there. It lands
 * without travelling on first show and when the container resizes. While `hold` is set the caller is placing it
 * (a drag), and it is left alone until released.
 */
export function useLiquid(
  axis: "x" | "y",
  active: string | null,
  box: HTMLElement | null,
  el: HTMLElement | null,
  hold = false,
) {
  const last = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!box || !el || hold) return;

    const place = (instant: boolean) => {
      const target = active ? box.querySelector<HTMLElement>(`[data-liquid-key="${active}"]`) : null;
      if (!target) {
        el.style.opacity = "0";
        last.current = null;
        return;
      }
      const start = axis === "x" ? target.offsetLeft : target.offsetTop;
      const size = axis === "x" ? target.offsetWidth : target.offsetHeight;
      const jump = instant || last.current === null;
      el.dataset.axis = axis;
      el.dataset.dir = last.current !== null && start < last.current ? "back" : "fwd";
      if (jump) el.style.transition = "none";
      el.style.setProperty("--ia", `${start}px`);
      el.style.setProperty("--ib", `${start + size}px`);
      el.style.opacity = "1";
      if (jump) {
        el.getBoundingClientRect();
        el.style.transition = "";
      }
      last.current = start;
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
