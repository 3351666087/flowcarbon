"use client";

import { clsx } from "clsx";
import { type Ref, useEffect, useRef, useState } from "react";
import { tick } from "./glass";

/**
 * Six boxes for a one-time code. Underneath is one ordinary input, so pasting a code, the keyboard's suggestion
 * from the email (one-time-code) and the numeric keypad all work; the boxes only draw what it holds. The code is
 * handed over as soon as the sixth digit lands. `error` clears the boxes and shakes them.
 */
export function OtpInput({
  onComplete,
  disabled,
  error,
  label,
  inputRef,
}: {
  onComplete: (code: string) => void;
  disabled?: boolean;
  error?: number;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!error) return;
    setValue("");
    const el = row.current;
    if (!el) return;
    el.classList.remove("fc-shake");
    el.getBoundingClientRect();
    el.classList.add("fc-shake");
  }, [error]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        aria-label={label}
        inputMode="numeric"
        autoComplete="one-time-code"
        // biome-ignore lint/a11y/noAutofocus: the boxes appear because a code was just sent to fill them
        autoFocus
        pattern="\d{6}"
        maxLength={6}
        disabled={disabled}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, "").slice(0, 6);
          if (next.length > value.length) tick();
          setValue(next);
          if (next.length === 6) onComplete(next);
        }}
        className="absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none focus-visible:outline-none selection:bg-transparent"
      />
      <div
        ref={row}
        aria-hidden
        className="grid grid-cols-6 gap-2"
        onAnimationEnd={(e) => e.animationName === "fc-shake" && e.currentTarget.classList.remove("fc-shake")}
      >
        {Array.from({ length: 6 }, (_, i) => {
          const digit = value[i];
          const current = focused && (i === value.length || (i === 5 && value.length === 6));
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the six positions are fixed
              key={i}
              className={clsx(
                "fc-field relative grid aspect-[4/5] place-items-center rounded-2xl text-[24px] font-semibold tabular-nums",
                current && "fc-otp-current",
                error && !value && "fc-otp-error",
              )}
            >
              {digit ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: a new digit in this box replays its arrival
                <span key={digit + i} className="fc-otp-digit">
                  {digit}
                </span>
              ) : current ? (
                <span className="fc-otp-caret" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
