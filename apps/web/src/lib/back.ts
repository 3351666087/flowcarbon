"use client";

import { useEffect, useRef } from "react";

/**
 * What is open on top of the page (sheets, dialogs, menus), most recent last. The phone's back button and the Escape
 * key close the topmost one only; with nothing open, back goes back in the page or leaves the app as usual.
 *
 * The Android shell asks `window.fcBack()` on back, and is told how many layers are open (`overlays(n)`) so that it
 * takes the back gesture while something is open and leaves it to the system otherwise.
 */
const stack: { current: () => void }[] = [];

interface Shell {
  overlays?: (n: number) => void;
}

function report() {
  try {
    (window as unknown as { FlowCarbonShell?: Shell }).FlowCarbonShell?.overlays?.(stack.length);
  } catch {
    // an older shell without the call: back then works as before
  }
}

/** Closes the topmost layer; false when nothing is open. */
function back() {
  const top = stack.at(-1);
  if (!top) return false;
  top.current();
  return true;
}

if (typeof window !== "undefined") {
  (window as unknown as { fcBack?: () => boolean }).fcBack = back;
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && back()) e.preventDefault();
  });
}

/** While `open`, this layer is the one back and Escape close (or step back within, for a layer with steps). */
export function useBackClose(close: () => void, open = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = {
      current: () => ref.current(),
    };
    stack.push(entry);
    report();
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      report();
    };
  }, [open]);
}
