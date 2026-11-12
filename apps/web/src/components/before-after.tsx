"use client";

import { clsx } from "clsx";
import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  appliedOf,
  glide,
  reducedMotion,
  type ShareTarget,
  type SplitView,
  statusLine,
  useTurnActions,
  useTurns,
} from "@/components/assistant";
import { tick } from "@/components/glass";
import { type LiveFloor, TowerScene } from "@/components/tower-scene";
import { Badge, Button, ErrorBox, Metric } from "@/components/ui";
import type { TurnOption, TurnPlan } from "@/lib/api-shapes";
import { useBackClose } from "@/lib/back";
import { co2, kwh, money, num, pct } from "@/lib/format";
import { type Dict, fill, useI18n } from "@/lib/i18n";
import { can, useBuilding, useIds, useMembership } from "@/lib/session";

const COUNT_MS = 800;
/** how long the After tower still looks like Before, so the floors can be seen clearing */
const CLEAR_AFTER_MS = 700;
/** keeps a figure with no change as tall as the one beside it */
const BLANK = "\u00a0";

/**
 * The building's figures with `saved` kWh gone: the planner's arithmetic (blended rates, the same green energy over a
 * lower total), for the sums it has no figure for: what is adopted plus an option, or the part of one that was applied.
 */
function withSaved(m: TurnOption["after"], saved: number): TurnOption["after"] {
  const kwhLeft = Math.max(0, m.kwh - saved);
  const avoidable = Math.max(0, m.avoidableKwh - saved);
  const scale = m.kwh > 0 ? kwhLeft / m.kwh : 0;
  return {
    kwh: kwhLeft,
    cost: m.cost * scale,
    co2eKg: m.co2eKg * scale,
    avoidableKwh: avoidable,
    avoidableShare: kwhLeft > 0 ? avoidable / kwhLeft : 0,
    greenShare: kwhLeft > 0 ? Math.min(1, (m.greenShare * m.kwh) / kwhLeft) : 0,
  };
}

/** The After side of a split for `covered` kWh of avoidable energy, with the two ends of its range. */
export function rangeOf(from: TurnOption["after"], covered: number, realisation: TurnPlan["realisation"]) {
  return {
    after: withSaved(from, covered * realisation.mid),
    low: withSaved(from, covered * realisation.low),
    high: withSaved(from, covered * realisation.high),
  };
}

/** A figure that runs from where it stands to `value`, here and whenever it changes. */
export function CountUp({
  value,
  from,
  format,
}: {
  value: number;
  from: number;
  format: (v: number) => string;
}) {
  const [shown, setShown] = useState(from);
  const current = useRef(from);
  useEffect(() => {
    if (reducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    const start = current.current;
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      // the first frame's timestamp can be earlier than t0, and a negative p would run the figure the wrong way
      const p = Math.max(0, Math.min(1, (now - t0) / COUNT_MS));
      current.current = start + (value - start) * (1 - (1 - p) ** 3);
      setShown(current.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{format(shown)}</>;
}

/** A change as a signed percentage of what it was, or in `unit` (percentage points) for a change in a share. */
function signed(share: number, locale: "en" | "zh", unit = "%") {
  const sign = share > 0 ? "+" : share < 0 ? "−" : "";
  return `${sign}${num(Math.abs(share) * 100, locale, 1)} ${unit}`;
}

/** The line under an applied option; on the demo the simulated tower follows it, and no data will verify it. */
export function inEffectLine(line: string, t: Dict, demo: boolean) {
  return demo && line === t.split.inEffect ? t.split.inEffectSim : line;
}

/**
 * The two sides of a change: the building as it is and as it is expected to be, on phones too. Before marks the floors
 * with avoidable energy the change acts on, whatever they happen to be doing this minute, and After shows those floors
 * put right, so the two sides differ even when nothing is wasting now. Every figure moves with the change it makes.
 * Nothing here is measured, so the side is labelled expected, and its basis and range stand under it. It lays its
 * figures out by its own width, so it fits a full page and a column beside the AI overview alike.
 */
export function SplitPanel({
  plan,
  before,
  figures,
  acted,
  floors,
  live,
  stacked = false,
}: {
  plan: TurnPlan;
  /** the Before side */
  before: TurnOption["after"];
  /** the After side, with the two ends of its range */
  figures: Pick<TurnOption, "after" | "low" | "high">;
  /** the floors the change acts on */
  acted: ReadonlySet<string>;
  /** the building's floors bottom up, in step with `live` */
  floors: readonly { floorId: string }[];
  live: readonly LiveFloor[];
  /** the Before side already counts what is adopted */
  stacked?: boolean;
}) {
  const { t, locale } = useI18n();
  const { building } = useBuilding();
  const currency = building?.currency ?? "CNY";
  const [cleared, setCleared] = useState(reducedMotion);
  useEffect(() => {
    if (cleared) return;
    const timer = setTimeout(() => setCleared(true), CLEAR_AFTER_MS);
    return () => clearTimeout(timer);
  }, [cleared]);

  const wasting = useMemo(
    () => live.map((f, i) => (acted.has(floors[i]?.floorId ?? "") ? { ...f, waste: true } : f)),
    [live, floors, acted],
  );
  const after = useMemo(
    () =>
      wasting.map((f, i) =>
        cleared && acted.has(floors[i]?.floorId ?? "") ? { ...f, waste: false, fixed: true } : f,
      ),
    [wasting, floors, acted, cleared],
  );

  const rows: {
    key: keyof TurnOption["after"];
    label: string;
    format: (v: number) => string;
    tone?: "waste" | "saving";
    /** a share, whose change is told in percentage points, not relative to what it was */
    share?: boolean;
  }[] = [
    { key: "kwh", label: t.split.energy, format: (v) => kwh(v, locale) },
    { key: "cost", label: t.split.cost, format: (v) => money(v, locale, currency) },
    { key: "co2eKg", label: t.floors.scope2, format: (v) => co2(v, locale) },
    { key: "avoidableKwh", label: t.split.avoidable, format: (v) => kwh(v, locale), tone: "waste" },
    {
      key: "avoidableShare",
      label: t.split.share,
      format: (v) => pct(v, locale, 1),
      tone: "waste",
      share: true,
    },
    {
      key: "greenShare",
      label: t.floors.greenShare,
      format: (v) => pct(v, locale, 1),
      tone: "saving",
      share: true,
    },
  ];
  const saved = (m: TurnOption["after"]) => kwh(before.kwh - m.kwh, locale);
  const column = "min-w-0 space-y-2 sm:space-y-3";
  const tower = "relative h-[220px] overflow-hidden rounded-2xl border border-border bg-surface sm:h-[280px]";
  // the whole tower fits, clear of the labels over it: a phone's column limits it by width, a wider one by height
  const scene =
    "absolute inset-0 size-full [--tower-scale:1.15] [--tower-y:0.54] sm:[--tower-scale:0.8] sm:[--tower-y:0.53]";
  const head = "pointer-events-none absolute inset-x-3 top-3 text-xs";
  const grid = "grid grid-cols-1 gap-2 sm:gap-3 @2xl:grid-cols-2";

  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <div className={column}>
          {floors.length ? (
            <div className={tower}>
              <TowerScene interactive={false} className={scene} live={wasting} />
              <div className={head}>
                <div className="font-semibold">{t.split.before}</div>
                <div className="num text-muted">
                  {fill(t.split.wasting, { n: wasting.filter((f) => f.waste).length })}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs font-semibold">{t.split.before}</div>
          )}
          <div className={grid}>
            {rows.map((r) => (
              <Metric key={r.key} label={r.label} tone={r.tone} value={r.format(before[r.key])} sub={BLANK} />
            ))}
          </div>
        </div>
        <div className={column}>
          {floors.length ? (
            <div className={tower}>
              <TowerScene interactive={false} className={scene} live={after} />
              <div className={head}>
                <div className="font-semibold text-saving">{t.split.after}</div>
                <div className="num text-muted">{fill(t.split.acting, { n: acted.size })}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs font-semibold text-saving">{t.split.after}</div>
          )}
          <div className={grid}>
            {rows.map((r) => {
              const was = before[r.key];
              const now = figures.after[r.key];
              return (
                <Metric
                  key={r.key}
                  label={r.label}
                  tone={r.tone}
                  value={<CountUp value={now} from={was} format={r.format} />}
                  sub={
                    r.share ? (
                      <span className="num font-medium text-saving">
                        <CountUp value={now - was} from={0} format={(v) => signed(v, locale, t.split.pp)} />
                      </span>
                    ) : was ? (
                      <span className="num font-medium text-saving">
                        <CountUp value={(now - was) / was} from={0} format={(v) => signed(v, locale)} />
                      </span>
                    ) : (
                      "–"
                    )
                  }
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1 text-xs text-muted">
        <p>{fill(t.split.basis, { days: plan.window.days })}</p>
        {stacked ? <p>{t.split.stacked}</p> : null}
        <p className="num">
          {fill(t.split.range, {
            low: saved(figures.low),
            high: saved(figures.high),
            shareHigh: pct(figures.low.avoidableShare, locale, 1),
            shareLow: pct(figures.high.avoidableShare, locale, 1),
            realLow: pct(plan.realisation.low, locale),
            realMid: pct(plan.realisation.mid, locale),
            realHigh: pct(plan.realisation.high, locale),
          })}
        </p>
        <p>{t.split.towers}</p>
      </div>
    </div>
  );
}

/**
 * What an option would do, opened over the first page: the two sides, a way to move between the plan's options, and
 * the option's own actions. Previewing creates nothing; applying goes through the same path as the option's card. Back
 * or Close returns to the page.
 */
export function BeforeAfter({
  view,
  floors,
  live,
  onChange,
  onClose,
  onShare,
}: {
  view: SplitView;
  /** the building's floors bottom up, in step with `live` */
  floors: readonly { floorId: string }[];
  live: readonly LiveFloor[];
  onChange: (view: SplitView) => void;
  onClose: () => void;
  onShare: (target: ShareTarget) => void;
}) {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const membership = useMembership();
  const role = membership?.role;
  const demo = membership?.orgPlan === "demo";
  const turns = useTurns();
  const { apply, undo } = useTurnActions();
  const reviewer = can.reviewFindings(role);
  const { plan } = view;
  const option = plan.options.find((o) => o.id === view.optionId) ?? plan.options[0]!;
  const turn = turns.data?.items.find((x) => x.id === view.turnId);
  const applied = turn?.appliedOption === option.id;
  const taken = !!turn?.appliedOption && !applied;
  // the turn's own words where a model named its options, and always in the language of the page
  const title = (id: TurnOption["id"]) =>
    turn?.reply?.options.find((o) => o.id === id)?.title || t.assistant.options[id] || id;
  useBackClose(onClose);

  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: glide(), block: "start" });
  }, []);
  // an old answer can apply only part of an option: what stands then is that part, not what the option promised
  const standing = turn?.appliedMeasures;
  const actions = useMemo(() => {
    const live = applied && standing?.filter((m) => m.status !== "cancelled");
    if (!live) return option.actions;
    return option.actions.filter((a) =>
      live.some((m) => m.floorId === a.floorId && m.strategyId === a.strategyId),
    );
  }, [option, applied, standing]);
  const acted = useMemo(() => new Set(actions.map((a) => a.floorId)), [actions]);
  const figures =
    actions.length === option.actions.length
      ? option
      : rangeOf(
          plan.before,
          actions.reduce((s, a) => s + a.coveredKwh, 0),
          plan.realisation,
        );

  return (
    <section ref={box} className="fc-rise mb-6 scroll-mt-[calc(var(--app-top)+72px)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {plan.options.length > 1 ? null : <h2 className="text-sm font-semibold">{title(option.id)}</h2>}
          {applied ? (
            <Badge tone="saving">{t.assistant.applied}</Badge>
          ) : (
            <Badge tone="accent">{t.split.previewing}</Badge>
          )}
        </div>
        <Button variant="ghost" className="min-h-11 shrink-0 sm:min-h-9" onClick={onClose}>
          <X className="size-4" aria-hidden /> {t.common.close}
        </Button>
      </div>
      {plan.options.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {plan.options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.id === option.id}
              onClick={() => {
                tick();
                onChange({ ...view, optionId: o.id });
              }}
              className={clsx(
                "fc-press min-h-11 rounded-full px-3 text-sm font-medium sm:min-h-9",
                o.id === option.id ? "bg-accent-soft text-accent" : "text-muted hover:text-text",
              )}
            >
              {title(o.id)}
            </button>
          ))}
        </div>
      ) : null}

      <SplitPanel
        plan={plan}
        before={plan.before}
        figures={figures}
        acted={acted}
        floors={floors}
        live={live}
        stacked={plan.adoptedKwh > 0}
      />
      {turn?.outdated ? <p className="mt-1 text-xs text-muted">{t.assistant.outdated}</p> : null}

      {turn && reviewer ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {applied ? (
            <>
              <span className="text-sm">
                {inEffectLine(statusLine(turn.appliedMeasures ?? [], t), t, demo)}{" "}
                {appliedOf(turn).n < appliedOf(turn).total
                  ? fill(t.assistant.appliedSome, appliedOf(turn))
                  : null}
              </span>
              <Link
                href={`/o/${orgId}/b/${buildingId}/measures`}
                className="inline-flex min-h-11 items-center text-sm font-medium text-accent sm:min-h-9"
              >
                {t.split.seeMeasures}
              </Link>
              <Button
                className="min-h-11 sm:min-h-9"
                busy={undo.isPending}
                onClick={() => undo.mutate(turn.id)}
              >
                {t.plan.undo}
              </Button>
              <Button
                variant="ghost"
                className="min-h-11 text-accent sm:min-h-9"
                onClick={() => onShare({ turnId: turn.id, option: option.id })}
              >
                {t.community.share}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                className="min-h-11 sm:min-h-9"
                disabled={taken}
                busy={apply.isPending}
                onClick={() => apply.mutate({ turnId: turn.id, option: option.id })}
              >
                {t.split.applyThis}
              </Button>
              {taken ? <span className="text-xs text-muted">{t.assistant.oneAtATime}</span> : null}
            </>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">{t.assistant.previewOnly}</p>
      )}
      {apply.error ? (
        <div className="mt-3">
          <ErrorBox error={apply.error} />
        </div>
      ) : null}
    </section>
  );
}
