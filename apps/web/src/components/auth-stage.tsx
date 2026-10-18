"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Backdrop, useLens } from "./glass";
import { MarkTile } from "./mark";
import { TowerScene } from "./tower-scene";

/**
 * The stage for signing in and accepting an invitation: the live tower is the content, and the form floats over it as
 * a sheet of glass — inset from the screen edges on a phone so the scene shows around it, beside the tower on a wide
 * screen. `shake` replays a refusal shake each time it changes.
 */
export function AuthStage({
  title,
  subtitle,
  onSubmit,
  shake = 0,
  children,
}: {
  title: string;
  subtitle?: string;
  onSubmit: (e: FormEvent) => void;
  shake?: number;
  children: ReactNode;
}) {
  const { t, locale, setLocale } = useI18n();
  const sheet = useLens<HTMLFormElement>({ bezel: 36, depth: 34 });
  const lang = useLens<HTMLButtonElement>({ bezel: 12, depth: 8 });
  const form = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = form.current;
    if (!shake || !el) return;
    el.classList.remove("fc-shake");
    el.getBoundingClientRect();
    el.classList.add("fc-shake");
  }, [shake]);

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(400px,460px)] lg:gap-12 lg:px-14">
      <Backdrop intense />
      {/* the scene runs on under the sheet, so the glass has something to bend */}
      <TowerScene className="absolute inset-0 size-full [--tower-scale:1.12] [--tower-y:0.4] lg:[--tower-scale:0.8] lg:[--tower-x:0.52] lg:[--tower-y:0.47]" />
      <div className="fc-rise relative z-10 flex items-center gap-3 px-5 pt-5 lg:absolute lg:inset-x-14 lg:top-10 lg:px-0 lg:pt-0">
        <MarkTile className="size-10" motion="settle" />
        <div className="leading-tight">
          <div className="text-[17px] font-semibold tracking-tight">{t.appName}</div>
          <div className="text-xs text-muted">{t.tagline}</div>
        </div>
        <button
          ref={lang.ref}
          style={lang.style}
          type="button"
          onClick={() => setLocale(locale === "en" ? "zh" : "en")}
          className="fc-glass fc-press ml-auto h-9 rounded-full px-4 text-[13px] font-medium"
        >
          {lang.defs}
          {t.common.language}
        </button>
      </div>
      <section className="relative flex min-h-[42dvh] flex-1 flex-col lg:min-h-dvh">
        <div className="fc-rise relative z-10 mt-auto hidden pb-16 [animation-delay:200ms] lg:block">
          <h2 className="max-w-[24rem] text-[40px] leading-[1.1] font-semibold tracking-tight text-balance">
            {t.login.hero}
          </h2>
          <p className="mt-4 max-w-[24rem] text-[15px] text-muted text-pretty">{t.login.heroSub}</p>
        </div>
      </section>

      <div className="relative z-10 px-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:flex lg:items-center lg:px-0 lg:pb-0">
        <div
          ref={form}
          onAnimationEnd={(e) =>
            e.animationName === "fc-shake" && e.currentTarget.classList.remove("fc-shake")
          }
          className="w-full"
        >
          {/* the entrance runs on the glass itself: an animating parent would hide the backdrop from it */}
          <form
            ref={sheet.ref}
            style={sheet.style}
            onSubmit={onSubmit}
            className="fc-glass fc-condense w-full rounded-[34px] p-5 [animation-delay:250ms] sm:p-7"
          >
            {sheet.defs}
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
            <div className="mt-5">{children}</div>
          </form>
        </div>
      </div>
    </main>
  );
}

/** Fields grouped in one recessed panel, iOS settings style, divided by hairlines. */
export function FieldGroup({ children }: { children: ReactNode }) {
  return (
    <div className="fc-field divide-y divide-[var(--glass-hairline)] overflow-hidden rounded-[18px]">
      {children}
    </div>
  );
}

export function GroupField({
  label,
  children,
  trailing,
}: {
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-end gap-2 px-4 pt-2.5 pb-2">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child */}
      <label className="block min-w-0 flex-1">
        <span className="block text-[11.5px] font-medium text-muted">{label}</span>
        {children}
      </label>
      {trailing}
    </div>
  );
}

// the group draws the focus ring for its fields
export const groupInput =
  "block w-full min-w-0 bg-transparent py-0.5 text-[16px] outline-none focus-visible:outline-none placeholder:text-muted";

/** An iOS-style switch: the knob stretches while pressed and springs across. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`fc-switch relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-300 ${checked ? "bg-accent" : "bg-[var(--glass-hairline)] shadow-[inset_0_0_0_1px_var(--glass-hairline)]"}`}
    >
      <span className="fc-switch-knob" data-on={checked || undefined} />
    </button>
  );
}

/**
 * Whether the session should be kept. Inside the Android app it always is, as apps are, and the choice is not
 * shown; in a browser it is on unless the user turns it off (a shared computer).
 */
export function useRemember() {
  const [inApp, setInApp] = useState(false);
  const [remember, setRemember] = useState(true);
  useEffect(() => setInApp("FlowCarbonShell" in window), []);
  return { inApp, remember: inApp || remember, setRemember };
}

export function RememberRow({
  label,
  hint,
  remember,
  setRemember,
}: {
  label: string;
  hint: string;
  remember: boolean;
  setRemember: (v: boolean) => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-3 px-1">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      <Switch checked={remember} onChange={setRemember} label={label} />
    </div>
  );
}
