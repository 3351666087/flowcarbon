"use client";

import { useEffect, useRef, useState } from "react";

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

/**
 * A view that takes a step in the browser's history, so that its Back closes the view and stays on the page, on phones
 * outside the app too. Closing goes through that step as well, which leaves history as it was. `onClosed` gets the view
 * that closed. If the page is left with the view open the step stays behind, as an entry for the same page.
 */
export function useHistoryView<T>(onClosed?: (view: T) => void) {
  const [view, setView] = useState<T | null>(null);
  const stepped = useRef(false);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const shown = useRef(view);
  shown.current = view;
  useEffect(() => {
    const popped = () => {
      stepped.current = false;
      const last = shown.current;
      setView(null);
      if (last !== null) closed.current?.(last);
    };
    addEventListener("popstate", popped);
    return () => removeEventListener("popstate", popped);
  }, []);
  const show = (next: T) => {
    if (!stepped.current) history.pushState(history.state, "");
    stepped.current = true;
    setView(next);
  };
  const close = () => {
    if (stepped.current) history.back();
  };
  return [view, show, close] as const;
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
