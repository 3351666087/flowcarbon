"use client";

import { clsx } from "clsx";
import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { tick } from "@/components/glass";
import { IntroVideoLink } from "@/components/intro-video";
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
 * A short guided first use: what the product does, then where to look, what to ask and where to act. It sits
 * compact (one line per step) under the page's status line; "More" opens a sentence on each step.
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
  const [more, setMore] = useState(false);

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
      className="fc-rise relative mb-4 rounded-2xl border border-border bg-surface px-4 py-3"
    >
      <button
        type="button"
        aria-label={t.firstUse.close}
        title={t.firstUse.close}
        onClick={() => {
          tick();
          onDone();
        }}
        className="fc-press absolute top-1 right-1 grid size-11 place-items-center rounded-full text-muted hover:text-text sm:size-9"
      >
        <X className="size-4" aria-hidden />
      </button>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-10">
        <h2 id="first-use-title" className="text-sm font-semibold tracking-tight">
          {t.firstUse.title}
        </h2>
        <p className="text-xs text-muted">{t.firstUse.what}</p>
        {membership?.orgPlan === "demo" ? (
          <p className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t.firstUse.demo}</p>
        ) : null}
      </div>
      {/* testers found the product hard to place at first: the film shows it in a minute */}
      <IntroVideoLink className="mt-1 text-sm text-accent" />
      {/* compact by default: each step is its title and where to go; "More" adds a line on each */}
      <ol className={clsx("mt-2 text-sm", more ? "grid gap-2 md:grid-cols-3" : "flex flex-wrap gap-x-5")}>
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={clsx("flex gap-2", more ? "rounded-xl bg-surface-2 p-3" : "items-center")}
          >
            <span className="num grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
              {i + 1}
            </span>
            <span className={clsx("min-w-0", more ? "block" : "flex flex-wrap items-center gap-x-2")}>
              <span className={clsx("font-medium", more && "block")}>{s.title}</span>
              {more ? <span className="mt-0.5 block text-xs text-muted">{s.body}</span> : null}
              {s.action ? <span className={more ? "mt-1 block" : undefined}>{s.action}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-1 flex justify-end gap-4">
        <button
          type="button"
          aria-expanded={more}
          onClick={() => {
            tick();
            setMore((m) => !m);
          }}
          className="fc-press inline-flex min-h-11 items-center text-xs font-medium text-muted hover:text-text sm:min-h-0"
        >
          {more ? t.firstUse.less : t.common.more}
        </button>
        <button
          type="button"
          onClick={() => {
            tick();
            onDone();
          }}
          className="fc-press inline-flex min-h-11 items-center text-xs font-semibold text-accent sm:min-h-0"
        >
          {t.firstUse.gotIt}
        </button>
      </div>
    </section>
  );
}
