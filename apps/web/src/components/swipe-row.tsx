"use client";

import { clsx } from "clsx";
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { feel } from "@/components/glass";

export interface SwipeAction {
  key: string;
  label: string;
  icon?: ReactNode;
  tone: "accent" | "danger" | "neutral";
  run: () => void;
}

const ACTION_WIDTH = 78;

/**
 * A row that slides left under the finger to show its actions, as list rows do in phone apps; a tap on an open row
 * closes it. Where there is a mouse, a ⋯ button at the end opens it instead. Vertical drags scroll the list as usual.
 */
export function SwipeRow({
  actions,
  open,
  onOpenChange,
  label,
  children,
}: {
  actions: SwipeAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** names the ⋯ button for screen readers */
  label: string;
  children: ReactNode;
}) {
  const width = actions.length * ACTION_WIDTH;
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null } | null>(null);
  const moved = useRef(false);
  const passed = useRef(false);

  useEffect(() => setX(open ? -width : 0), [open, width]);

  if (!actions.length) return <>{children}</>;
  const shown = Math.max(0, -x);
  return (
    <div
      className="relative overflow-hidden"
      style={{ touchAction: "pan-y" }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        start.current = { x: e.clientX, y: e.clientY, base: open ? -width : 0, axis: null };
        moved.current = false;
        passed.current = open;
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!s.axis) {
          if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
            s.axis = "x";
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // the finger already lifted
            }
            setDragging(true);
          } else if (Math.abs(dy) > 8) s.axis = "y";
          else return;
        }
        if (s.axis !== "x") return;
        moved.current = true;
        let next = s.base + dx;
        // past either end it resists, like a rubber band
        if (next > 0) next *= 0.25;
        if (next < -width) next = -width + (next + width) * 0.25;
        const over = next < -width / 2;
        if (over !== passed.current) {
          passed.current = over;
          feel("tick");
        }
        setX(next);
      }}
      onPointerUp={() => {
        const s = start.current;
        start.current = null;
        if (s?.axis !== "x") return;
        setDragging(false);
        const nowOpen = x < -width / 2;
        setX(nowOpen ? -width : 0);
        if (nowOpen !== open) onOpenChange(nowOpen);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
        setX(open ? -width : 0);
      }}
    >
      <div className="absolute inset-y-0 right-0 flex overflow-hidden" style={{ width: shown }}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              feel("press");
              onOpenChange(false);
              a.run();
            }}
            className={clsx(
              "fc-press flex h-full shrink-0 flex-col items-center justify-center gap-1 text-xs font-semibold text-white",
              a.tone === "danger" ? "bg-danger" : a.tone === "accent" ? "bg-accent" : "bg-muted",
            )}
            style={{ width: ACTION_WIDTH }}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
      <div
        className={clsx("relative flex items-center", !dragging && "transition-transform duration-300")}
        style={{
          transform: `translate3d(${x}px,0,0)`,
          transitionTimingFunction: "cubic-bezier(0.2, 0.9, 0.25, 1.05)",
        }}
        onClickCapture={(e) => {
          // a drag is not a tap; a tap on an open row only closes it
          if (moved.current || open) {
            e.preventDefault();
            e.stopPropagation();
            moved.current = false;
            if (open) onOpenChange(false);
          }
        }}
      >
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            onOpenChange(!open);
          }}
          className="fc-press mr-2 hidden size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-[var(--glass-field)] [@media(hover:hover)]:grid"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
