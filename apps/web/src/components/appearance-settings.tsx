"use client";

import { clsx } from "clsx";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ACCENTS,
  type Accent,
  applyAccent,
  applyTextSize,
  readAccent,
  readTextSize,
  type TextSize,
} from "@/lib/appearance";
import { useI18n } from "@/lib/i18n";
import { Segmented } from "./auth-code";
import { tick } from "./glass";

/** one colour per accent for its swatch, between its light and dark values so it reads on either */
const SWATCH: Record<Accent, string> = {
  teal: "#14958a",
  blue: "#3b7ddd",
  green: "#5a9e2f",
  violet: "#8a66e0",
  rose: "#d04f92",
};

/** Text size and accent colour, as two rows for the account menu's preferences, under the light/dark switch. */
export function AppearanceSettings() {
  const { t } = useI18n();
  const [size, setSize] = useState<TextSize>("default");
  const [accent, setAccent] = useState<Accent>("teal");

  useEffect(() => {
    setSize(readTextSize());
    setAccent(readAccent());
  }, []);

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-[15px]">{t.account.textSize}</span>
        <div className="w-[208px]">
          <Segmented
            label={t.account.textSize}
            value={size}
            onChange={(v) => {
              setSize(v);
              applyTextSize(v);
            }}
            options={[
              { key: "small", label: t.account.textSmall },
              { key: "default", label: t.account.textDefault },
              { key: "large", label: t.account.textLarge },
            ]}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="text-[15px]">{t.account.accent}</span>
        <div className="flex items-center gap-0.5">
          {ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={accent === a}
              aria-label={`${t.account.accent}: ${t.account.accents[a]}`}
              title={t.account.accents[a]}
              onClick={() => {
                if (accent === a) return;
                tick();
                setAccent(a);
                applyAccent(a);
              }}
              className="fc-press grid size-10 place-items-center rounded-full"
            >
              <span
                className={clsx(
                  "grid size-7 place-items-center rounded-full text-white shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.18)]",
                  accent === a && "ring-2 ring-text/70 ring-offset-2 ring-offset-surface",
                )}
                style={{ background: SWATCH[a] }}
              >
                {accent === a ? <Check className="size-4" strokeWidth={3} aria-hidden /> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
