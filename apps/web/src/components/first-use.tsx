"use client";

import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { tick } from "@/components/glass";
import { useI18n } from "@/lib/i18n";
import { PAGES, useIds, useMembership } from "@/lib/session";

/** Set once someone has read the guide; "How it works" clears it again. */
const HIDDEN_KEY = "flowcarbon.firstUse.hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // storage unavailable: the choice lasts as long as the page
  }
}

/** Whether the guide is on show, read after mount so the server and the first render agree. */
export function useFirstUse() {
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(!readHidden()), []);
  const hide = useCallback(() => {
    writeHidden(true);
    setShown(false);
  }, []);
  const show = useCallback(() => {
    writeHidden(false);
    setShown(true);
  }, []);
  return { shown, hide, show };
}

/** The small header link that brings the guide back. */
export function FirstUseLink({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        tick();
        onClick();
      }}
      className="fc-press inline-flex min-h-11 items-center text-xs font-medium text-accent sm:min-h-0"
    >
      {t.firstUse.howItWorks}
    </button>
  );
}

const linkClass = "fc-press inline-flex min-h-11 items-center gap-0.5 font-medium text-accent sm:min-h-0";

/**
 * A short guided first use: what the product does, then where to look, what to ask and where to act.
 * `onTower` and `onAssistant` scroll to those parts of the floors page; a step a role can't take is left out.
 */
export function FirstUse({
  onDone,
  onTower,
  onAssistant,
}: {
  onDone: () => void;
  onTower?: () => void;
  onAssistant?: () => void;
}) {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const membership = useMembership();
  const role = membership?.role;
  const base = `/o/${orgId}/b/${buildingId}`;
  const strategies = !!role && !!PAGES.strategies?.includes(role);
  const twin = !!role && !!PAGES.twin?.includes(role);

  const steps = [
    {
      title: t.firstUse.step1,
      body: t.firstUse.step1Body,
      action: onTower ? (
        <button type="button" onClick={onTower} className={linkClass}>
          {t.firstUse.step1Link} <ChevronRight className="size-4" aria-hidden />
        </button>
      ) : null,
    },
    onAssistant
      ? {
          title: t.firstUse.step2,
          body: t.firstUse.step2Body,
          action: (
            <button type="button" onClick={onAssistant} className={linkClass}>
              {t.firstUse.step2Link} <ChevronRight className="size-4" aria-hidden />
            </button>
          ),
        }
      : null,
    strategies
      ? {
          title: t.firstUse.step3,
          body: t.firstUse.step3Body,
          action: (
            <span className="flex flex-wrap gap-x-4">
              <Link href={`${base}/strategies`} className={linkClass}>
                {t.firstUse.step3Strategies} <ChevronRight className="size-4" aria-hidden />
              </Link>
              {twin ? (
                <Link href={`${base}/twin`} className={linkClass}>
                  {t.firstUse.step3Twin} <ChevronRight className="size-4" aria-hidden />
                </Link>
              ) : null}
            </span>
          ),
        }
      : null,
  ].filter((s) => s !== null);

  return (
    <section
      aria-labelledby="first-use-title"
      className="fc-rise relative mb-6 rounded-2xl border border-border bg-surface p-4 sm:p-5"
    >
      <button
        type="button"
        aria-label={t.firstUse.close}
        title={t.firstUse.close}
        onClick={() => {
          tick();
          onDone();
        }}
        className="fc-press absolute top-2 right-2 grid size-11 place-items-center rounded-full text-muted hover:text-text sm:size-9"
      >
        <X className="size-4" aria-hidden />
      </button>
      <h2 id="first-use-title" className="pr-10 text-base font-semibold tracking-tight">
        {t.firstUse.title}
      </h2>
      <p className="mt-1 pr-10 text-sm text-muted">{t.firstUse.what}</p>
      {membership?.orgPlan === "demo" ? (
        <p className="mt-2 inline-block rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
          {t.firstUse.demo}
        </p>
      ) : null}
      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-xl bg-surface-2 p-3">
            <span className="num grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
              {i + 1}
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{s.title}</span>
              <span className="mt-0.5 block text-xs text-muted">{s.body}</span>
              {s.action ? <span className="mt-1 block">{s.action}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => {
            tick();
            onDone();
          }}
          className="fc-press fc-prominent inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold sm:min-h-9"
        >
          {t.firstUse.gotIt}
        </button>
      </div>
    </section>
  );
}
