"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { feel } from "./glass";
import { Mark } from "./mark";

const ARM = 72;

/**
 * Pull down at the top of a page to refresh it, the way Android apps do: a glass disc carrying the mark drops in
 * under the header and turns as it is pulled, ticks once when letting go would refresh, and breathes while every
 * query on screen is fetched again. Touch screens only.
 */
export function PullToRefresh() {
  const qc = useQueryClient();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    let startY: number | null = null;
    let distance = 0;
    let armed = false;
    const onStart = (e: TouchEvent) => {
      const root = document.documentElement;
      startY =
        !busy.current && e.touches.length === 1 && scrollY <= 0 && !root.classList.contains("fc-locked")
          ? e.touches[0]!.clientY
          : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      // resistance grows with distance, like a rubber band
      distance = dy <= 0 ? 0 : Math.min(150, dy * 0.55 - (dy * dy) / 4000);
      setPull(Math.max(0, distance));
      if (distance > ARM !== armed) {
        armed = distance > ARM;
        if (armed) feel("tick");
      }
    };
    const onEnd = async () => {
      if (startY === null) return;
      startY = null;
      if (armed) {
        busy.current = true;
        setRefreshing(true);
        setPull(64);
        try {
          await qc.refetchQueries({ type: "active" });
          feel("confirm");
        } finally {
          busy.current = false;
          setRefreshing(false);
          setPull(0);
        }
      } else setPull(0);
      armed = false;
      distance = 0;
    };
    addEventListener("touchstart", onStart, { passive: true });
    addEventListener("touchmove", onMove, { passive: true });
    addEventListener("touchend", onEnd);
    addEventListener("touchcancel", onEnd);
    return () => {
      removeEventListener("touchstart", onStart);
      removeEventListener("touchmove", onMove);
      removeEventListener("touchend", onEnd);
      removeEventListener("touchcancel", onEnd);
    };
  }, [qc]);

  return (
    <div
      aria-hidden
      className="fc-ptr lg:hidden"
      data-active={pull > 0 || refreshing || undefined}
      data-armed={pull > ARM || refreshing || undefined}
      style={{ "--pull": `${pull}px`, "--turn": `${pull * 3}deg` } as CSSProperties}
    >
      <span className="fc-glass fc-glass-strong grid size-11 place-items-center rounded-full text-accent">
        <span className="fc-ptr-mark grid place-items-center">
          <Mark motion={refreshing ? "breathe" : undefined} className="size-6" />
        </span>
      </span>
    </div>
  );
}
