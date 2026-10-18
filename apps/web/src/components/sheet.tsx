"use client";

import { clsx } from "clsx";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLens } from "@/components/glass";
import { useI18n } from "@/lib/i18n";

/**
 * A sheet that rises from the bottom on a phone (drag the handle down, tap outside or press Escape to put it away)
 * and opens as a centred panel on a wide screen. Render it while it is open; `children` gets a `close` that plays
 * the exit before `onClose`, for closing after a successful action.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  footer?: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const lens = useLens<HTMLDivElement>({ bezel: 30, depth: 22 });
  const panel = useRef<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);

  const close = () => {
    setLeaving(true);
    setTimeout(onClose, 260);
  };
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (mounted) panel.current?.focus();
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end lg:items-center lg:justify-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label={t.common.close}
        tabIndex={-1}
        onClick={close}
        className={clsx("fc-scrim absolute inset-0 cursor-default", leaving && "fc-scrim-out")}
      />
      <div
        ref={(node) => {
          panel.current = node;
          lens.ref(node);
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ ...lens.style, ...(drag ? { transform: `translateY(${drag}px)`, transition: "none" } : {}) }}
        className={clsx(
          "fc-glass fc-glass-strong fc-sheet fc-sheet-center relative mx-2 mb-[calc(var(--app-bottom)+8px)] flex max-h-[min(88dvh,780px)] flex-col overflow-hidden rounded-[32px] outline-none lg:mx-0 lg:mb-0 lg:w-[480px]",
          leaving && "fc-sheet-out",
        )}
      >
        {lens.defs}
        <div
          className="flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-1 lg:hidden"
          onPointerDown={(e) => {
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            start.current = null;
            if (drag > 90) close();
            setDrag(0);
          }}
        >
          <span className="h-1.5 w-10 rounded-full bg-[var(--glass-hairline)] shadow-[inset_0_0_0_1px_var(--glass-hairline)]" />
        </div>
        <div className="flex shrink-0 items-center gap-3 px-5 pt-1 pb-2 lg:pt-5">
          <h2 className="min-w-0 flex-1 text-[17px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label={t.common.close}
            className="fc-press hidden size-8 place-items-center rounded-full bg-[var(--glass-field)] text-muted lg:grid"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          {typeof children === "function" ? children(close) : children}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-[var(--glass-hairline)] px-5 py-3">{footer(close)}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
