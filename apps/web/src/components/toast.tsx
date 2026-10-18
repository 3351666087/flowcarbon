"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { feel } from "@/components/glass";

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

let current: Toast | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** A short note at the bottom of the screen, optionally with one action (usually Undo). */
export function toast(text: string, action?: Toast["action"]) {
  current = { id: ++seq, text, action };
  emit();
}

export function Toaster() {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!t) return;
    setLeaving(false);
    const out = setTimeout(() => setLeaving(true), t.action ? 6500 : 4000);
    const gone = setTimeout(
      () => {
        if (current?.id === t.id) {
          current = null;
          emit();
        }
      },
      t.action ? 6800 : 4300,
    );
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, [t]);
  if (!t) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--app-bottom)+92px)] z-[60] flex justify-center px-4 lg:bottom-6"
    >
      <div
        key={t.id}
        className={`fc-glass fc-glass-strong fc-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-full py-2 pr-2 pl-4 text-sm shadow-lg ${leaving ? "fc-toast-out" : ""}`}
      >
        <span className="min-w-0 flex-1">{t.text}</span>
        {t.action ? (
          <button
            type="button"
            onClick={() => {
              feel("press");
              t.action?.run();
              current = null;
              emit();
            }}
            className="fc-press shrink-0 rounded-full bg-[var(--glass-field)] px-3 py-1.5 font-semibold text-accent"
          >
            {t.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
