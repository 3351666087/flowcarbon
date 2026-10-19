"use client";

import { clsx } from "clsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { feel } from "@/components/glass";
import { useBackClose } from "@/lib/back";
import { useI18n } from "@/lib/i18n";

/**
 * A question that needs an answer before anything else, centred like a system alert. A destructive confirmation can
 * ask to be held down (`hold`), so it cannot happen by a stray tap.
 */
export function Dialog({
  title,
  children,
  confirm,
  tone = "accent",
  hold = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirm: string;
  tone?: "accent" | "danger";
  hold?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (mounted) card.current?.focus();
  }, [mounted]);
  // while it is working, back stays here rather than leaving mid-way
  useBackClose(() => {
    if (!busy) onClose();
  });

  const begin = () => {
    if (busy) return;
    if (!hold) {
      onConfirm();
      return;
    }
    feel("tick");
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      feel("confirm");
      onConfirm();
    }, 1200);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-6" role="presentation">
      <button
        type="button"
        aria-label={t.common.close}
        tabIndex={-1}
        onClick={onClose}
        className="fc-scrim absolute inset-0 cursor-default"
      />
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="fc-glass fc-glass-strong fc-bloom relative w-full max-w-[340px] rounded-[28px] p-5 outline-none"
      >
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onPointerDown={hold ? begin : undefined}
            onPointerUp={hold ? cancel : undefined}
            onPointerLeave={hold ? cancel : undefined}
            onKeyDown={(e) => hold && (e.key === "Enter" || e.key === " ") && !e.repeat && begin()}
            onKeyUp={hold ? cancel : undefined}
            onClick={hold ? undefined : begin}
            className={clsx(
              "fc-press relative h-11 overflow-hidden rounded-full text-[15px] font-semibold select-none disabled:opacity-60",
              tone === "danger" ? "bg-danger-soft text-danger" : "fc-prominent",
            )}
          >
            {hold ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-danger/25"
                style={{
                  width: holding ? "100%" : "0%",
                  transition: holding ? "width 1200ms linear" : "width 200ms ease-out",
                }}
              />
            ) : null}
            <span className="relative">{confirm}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="fc-press h-11 rounded-full text-[15px] font-medium text-muted hover:text-text"
          >
            {t.common.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
