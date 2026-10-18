"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useLiquid } from "./liquid";

/** Whether this server can email codes (it needs an SMTP relay configured). */
export function useAuthMethods() {
  return useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => unwrap(api.GET("/api/v1/auth/methods")),
    staleTime: 5 * 60_000,
  });
}

/**
 * Sends one-time codes by email and paces the resend button: the server sends at most one code per 45 seconds and
 * answers the same whether or not the address has an account, so the form cannot tell either.
 */
export function useCodeSender(purpose: "sign_in" | "password_reset") {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until, now]);

  async function send(email: string) {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/api/v1/auth/code", { body: { email, purpose } }));
      setSentTo(email);
      setUntil(Date.now() + 45_000);
      setNow(Date.now());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return { send, sentTo, busy, error, wait: Math.max(0, Math.ceil((until - now) / 1000)) };
}

/** A message for errors from the code endpoints, in the reader's language where the cause is known. */
export function useCodeError() {
  const { t } = useI18n();
  return (error: unknown) =>
    error instanceof ApiError && error.status === 401
      ? t.login.codeWrong
      : error instanceof ApiError && error.status === 503
        ? t.login.mailOff
        : error instanceof Error
          ? error.message
          : error
            ? String(error)
            : null;
}

/** An iOS segmented control whose selection slides between segments like the tab bar's. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [mark, setMark] = useState<HTMLSpanElement | null>(null);
  useLiquid("x", value, box, mark);
  return (
    <div ref={setBox} role="tablist" aria-label={label} className="fc-field relative flex rounded-full p-1">
      <span
        ref={setMark}
        className="fc-liquid top-1! bottom-1! bg-surface shadow-[0_2px_8px_rgb(0_0_0/0.12),inset_0_0_0_0.5px_var(--glass-hairline)]"
      />
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          data-liquid-key={o.key}
          onClick={() => onChange(o.key)}
          className={clsx(
            "fc-press relative z-10 flex-1 rounded-full py-1.5 text-[13px] font-medium",
            value === o.key ? "text-text" : "text-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The six-digit code field: numeric keypad, and the code offered by the keyboard when the email arrives. */
export const codeInputProps = {
  inputMode: "numeric",
  autoComplete: "one-time-code",
  pattern: "\\d{6}",
  maxLength: 6,
} as const;
