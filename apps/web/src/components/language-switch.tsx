"use client";

import { clsx } from "clsx";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { tick, useLens } from "./glass";
import { useLiquid } from "./liquid";

const OPTIONS = [
  { key: "en", label: "EN" },
  { key: "zh", label: "中文" },
] as const;

/**
 * A two-way glass switch for the interface language. The thumb slides across; the page dissolves into the other
 * language (I18nProvider runs the switch as a view transition).
 */
export function LanguageSwitch({ className, glass = true }: { className?: string; glass?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const lens = useLens<HTMLFieldSetElement>({ bezel: 12, depth: 8, disabled: !glass });
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<HTMLSpanElement | null>(null);
  useLiquid("x", locale, box, thumb);
  return (
    <fieldset
      ref={lens.ref}
      style={lens.style}
      aria-label={t.account.language}
      className={clsx(glass ? "fc-glass" : "fc-field", "m-0 min-w-0 rounded-full border-0 p-1", className)}
    >
      {lens.defs}
      <div ref={setBox} className="relative flex">
        <span
          ref={setThumb}
          className="fc-liquid bg-[var(--glass-tint-strong)] shadow-[0_1px_4px_rgb(0_0_0/0.14),inset_0_0_0_0.5px_var(--glass-hairline)]"
        />
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={locale === o.key}
            data-liquid-key={o.key}
            onClick={() => {
              if (locale === o.key) return;
              tick();
              setLocale(o.key);
            }}
            className={clsx(
              "fc-press relative z-10 min-w-11 rounded-full px-3 py-1 text-[13px] font-semibold transition-colors",
              locale === o.key ? "text-text" : "text-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
