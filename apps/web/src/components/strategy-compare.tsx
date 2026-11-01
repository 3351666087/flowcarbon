"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  glide,
  Limits,
  OptionFigures,
  statusLine,
  useStrategyBoard,
  useTurnActions,
  whole,
} from "@/components/assistant";
import { CountUp, rangeOf, SplitPanel } from "@/components/before-after";
import { tick } from "@/components/glass";
import { liveFloors } from "@/components/tower-scene";
import { Badge, Button, Card, ErrorBox, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { StrategyBoard, TurnOption, TurnPlan } from "@/lib/api-shapes";
import { day, kwh, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, useIds, useMembership } from "@/lib/session";

type Metrics = TurnOption["after"];
type Actions = ReturnType<typeof useTurnActions>;
/** An option adopted and not undone, with what is left of its measures. */
type AdoptedOption = StrategyBoard["applied"][number] & { rows: StrategyBoard["adopted"]["measures"] };

/** The cards keep these places, so one that is adopted turns over where it stood. */
const ORDER: readonly TurnOption["id"][] = ["weekends", "weekdays", "balanced", "community"];
const ADVICE = ["on_demand", "setback", "off"] as const;

const coveredBy = (rows: readonly { coveredKwh: number }[]) => rows.reduce((s, r) => s + r.coveredKwh, 0);

/** A priority of the AI overview taken into the comparison. Its figures are the plan's action for that floor. */
export interface ComparedPriority {
  floorId: string;
  strategyId: string;
  title: string;
  coveredKwh: number;
}

/** The running total of everything planned or in effect, whichever way it was adopted. */
function AdoptedSoFar({ plan, after, count }: { plan: TurnPlan; after: Metrics; count: number }) {
  const { recorded } = plan;
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  return (
    <section id="adopted-so-far" className="mt-3 rounded-2xl bg-saving-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h3 className="text-xs font-semibold text-saving">{t.strategies.adoptedSoFar}</h3>
        <Link
          href={`/o/${orgId}/b/${buildingId}/measures`}
          className="inline-flex min-h-11 items-center text-sm font-medium text-accent sm:min-h-0"
        >
          {t.split.seeMeasures}
        </Link>
      </div>
      <div className="num text-lg font-semibold tracking-tight text-saving">
        <CountUp value={recorded.kwh - after.kwh} from={0} format={(v) => kwh(v, locale)} />
      </div>
      <p className="num text-xs text-muted">
        {fill(t.strategies.adoptedLine, {
          n: count,
          days: plan.window.days,
          before: whole(pct(recorded.avoidableShare, locale, 1)),
          after: whole(pct(after.avoidableShare, locale, 1)),
        })}
      </p>
    </section>
  );
}

/** An option on offer: tap it to see it in the panel, adopt it from here or from under the panel. */
function OpenCard({
  plan,
  option,
  rest,
  selected,
  reviewer,
  adopt,
  onSelect,
  onAdopt,
}: {
  plan: TurnPlan;
  option: TurnOption;
  /** this option has been adopted once already, and this is what it left */
  rest: boolean;
  selected: boolean;
  reviewer: boolean;
  adopt: Actions["adopt"];
  onSelect: () => void;
  onAdopt: () => void;
}) {
  const { t } = useI18n();
  const title = t.assistant.options[option.id] ?? option.id;
  return (
    <li
      className={clsx(
        "flex flex-col rounded-2xl bg-surface-2 p-3",
        selected && "shadow-[inset_0_0_0_1.5px_var(--accent)]",
      )}
    >
      <button type="button" aria-pressed={selected} onClick={onSelect} className="fc-press block text-left">
        <span className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-sm font-medium">{rest ? fill(t.strategies.rest, { title }) : title}</span>
          {selected ? <Badge tone="accent">{t.strategies.comparing}</Badge> : null}
        </span>
        <OptionFigures plan={plan} option={option} />
      </button>
      {reviewer ? (
        <div className="mt-auto pt-3">
          <Button
            variant="primary"
            className="min-h-11 w-full sm:min-h-9"
            disabled={adopt.isPending}
            busy={adopt.isPending && adopt.variables === option.id}
            onClick={onAdopt}
          >
            {t.strategies.adopt}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The same card turned over: what the option left in place and how to take it back. */
function AdoptedCard({
  plan,
  card,
  fresh,
  reviewer,
  undo,
}: {
  plan: TurnPlan;
  card: AdoptedOption;
  /** adopted while watching, so it turns over */
  fresh: boolean;
  reviewer: boolean;
  undo: Actions["undo"];
}) {
  const { t, locale } = useI18n();
  const covered = coveredBy(card.rows);
  const { low, mid, high } = plan.realisation;
  return (
    <li
      className={clsx(
        "flex flex-col rounded-2xl bg-surface-2 p-3 shadow-[inset_0_0_0_1.5px_var(--saving)]",
        fresh && "fc-flip",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 className="text-sm font-medium">{t.assistant.options[card.option] ?? card.option}</h3>
        <Badge tone="saving">
          <Check className="size-3" aria-hidden /> {t.strategies.adopted}
        </Badge>
      </div>
      <div className="num mt-2 text-lg font-semibold tracking-tight text-saving">
        {kwh(covered * mid, locale)}
      </div>
      <div className="text-xs text-muted">{fill(t.assistant.saving, { days: plan.window.days })}</div>
      <div className="num text-xs text-muted">
        {fill(t.assistant.range, {
          low: whole(kwh(covered * low, locale)),
          high: whole(kwh(covered * high, locale)),
        })}
      </div>
      <p className="mt-1 text-xs">{statusLine(card.rows, t)}</p>
      {reviewer ? (
        <div className="mt-auto pt-3">
          <Button
            className="min-h-11 w-full sm:min-h-9"
            busy={undo.isPending && undo.variables === card.turnId}
            onClick={() => undo.mutate(card.turnId)}
          >
            {t.plan.undo}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The coming days: expected energy without and with what is adopted and the option being compared, each day's people
 * and cooling advice from the floor forecast under it. Every bar is labelled, so the bars only have to show the shape.
 */
function WeekAhead({
  plan,
  week,
  option,
}: {
  plan: TurnPlan;
  week: StrategyBoard["week"];
  option: TurnOption | null;
}) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const first = week.days[0]?.date;
  const forecast = useQuery({
    queryKey: ["forecast", orgId, buildingId, first],
    enabled: !!first,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/forecasts", {
          params: { path: { orgId, buildingId }, query: { from: first, days: week.days.length } },
        }),
      ),
  });

  const crowd = new Map<
    string,
    { people: number; floors: Partial<Record<(typeof ADVICE)[number], number>> }
  >();
  for (const r of forecast.data ?? []) {
    const d = crowd.get(r.day) ?? { people: 0, floors: {} };
    d.people += r.median;
    d.floors[r.advice] = (d.floors[r.advice] ?? 0) + 1;
    crowd.set(r.day, d);
  }

  const { low, mid, high } = plan.realisation;
  const coverage = week.coverage.filter((c) => c.option === option?.id);
  const rows = week.days.map((d) => {
    // the board has the adopted measures in; the option comes off at `mid`, its ends scaled from that
    const less = coverage.reduce((s, c) => s + c.perDayKwh[d.dayType], 0);
    const after = Math.max(0, d.withKwh - less);
    return {
      ...d,
      after,
      most: Math.max(0, d.lowKwh - (less * low) / mid),
      least: Math.max(0, d.highKwh - (less * high) / mid),
    };
  });
  // a day of a kind the data never saw has no figure, and adding it as zero would understate the week
  const known = rows.filter((r) => r.basis > 0);
  const sum = (pick: (r: (typeof rows)[number]) => number) => known.reduce((s, r) => s + pick(r), 0);
  const peak = Math.max(1, ...rows.map((r) => r.withoutKwh));
  const after = sum((r) => r.after);
  const moves = "transition-[width] duration-500";

  return (
    <Card title={t.strategies.week}>
      {known.length ? (
        <>
          <div className="num text-lg font-semibold tracking-tight">
            <span className="text-muted">
              {kwh(
                sum((r) => r.withoutKwh),
                locale,
              )}
            </span>{" "}
            → <CountUp value={after} from={after} format={(v) => kwh(v, locale)} />
          </div>
          <p className="num text-xs text-muted">
            {t.strategies.weekExpected} ·{" "}
            {fill(t.assistant.range, {
              low: whole(
                kwh(
                  sum((r) => r.least),
                  locale,
                ),
              ),
              high: whole(
                kwh(
                  sum((r) => r.most),
                  locale,
                ),
              ),
            })}
          </p>
          {known.length < rows.length ? (
            <p className="text-xs text-muted">
              {fill(t.strategies.weekGap, { n: rows.length - known.length })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px] bg-[var(--chart-4)]" aria-hidden />
              {t.strategies.legendAfter}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px] bg-[var(--chart-1)]" aria-hidden />
              {t.strategies.legendSaved}
            </span>
          </div>
          <ul className="mt-2 divide-y divide-border">
            {rows.map((r) => {
              const c = crowd.get(r.date);
              const notes = [
                r.dayType === "holiday" ? t.strategies.holiday : null,
                c ? fill(t.strategies.people, { n: c.people }) : crowd.size ? t.strategies.noForecast : null,
                ...ADVICE.map((k) => (c?.floors[k] ? whole(`${t.forecast.advice[k]} ${c.floors[k]}`) : null)),
              ].filter(Boolean);
              return (
                <li
                  key={r.date}
                  title={r.basis ? `${kwh(r.withoutKwh, locale)} → ${kwh(r.after, locale)}` : undefined}
                  className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-3 py-2"
                >
                  <span className="row-span-2 text-center">
                    <span className="block text-[11px] text-muted">
                      {day(r.date, locale, { weekday: "short" })}
                    </span>
                    <span className="num block text-[15px] leading-tight font-semibold">
                      {day(r.date, locale, { day: "numeric" })}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="flex h-2.5 min-w-0 flex-1 gap-0.5">
                      <span
                        className={clsx("rounded-l-[3px] bg-[var(--chart-4)]", moves)}
                        style={{ width: `${(r.after / peak) * 100}%` }}
                      />
                      <span
                        className={clsx("rounded-r-[3px] bg-[var(--chart-1)]", moves)}
                        style={{ width: `${((r.withoutKwh - r.after) / peak) * 100}%` }}
                      />
                    </span>
                    <span className="num w-[4.75rem] shrink-0 text-right text-xs font-medium">
                      {r.basis ? kwh(r.after, locale) : "–"}
                    </span>
                  </span>
                  {notes.length ? (
                    <span className="num mt-0.5 text-[11px] text-muted">{notes.join(" · ")}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">{fill(t.strategies.weekHint, { days: plan.window.days })}</p>
        </>
      ) : (
        <p className="text-sm text-muted">{t.common.noData}</p>
      )}
      <Link
        href={`/o/${orgId}/b/${buildingId}/forecast`}
        className="inline-flex min-h-11 items-center text-sm font-medium text-accent"
      >
        {t.strategies.fullTable}
      </Link>
    </Card>
  );
}

/**
 * The strategies open to the building side by side. Nothing here is AI: the board computes every figure from the
 * building's own data. Picking an option moves the Before/After panel and the week ahead, and creates nothing, so a
 * viewer can compare too. Adopting goes through the same path as applying an answer of the assistant, and shows:
 * the card turns over to Adopted, and what it saves moves into the running total, where it stays until it is undone.
 * The After side is what is adopted plus the option being compared, so the two can be read as one building.
 */
export function StrategyCompare({
  priority,
  onPick,
}: {
  /** on show instead of an option */
  priority: ComparedPriority | null;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const role = useMembership()?.role;
  const board = useStrategyBoard();
  const actions = useTurnActions();
  const overview = useQuery({
    queryKey: ["overview", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/overview", {
          params: { path: { orgId, buildingId } },
        }),
      ),
    refetchInterval: 60_000,
  });
  const [picked, setPicked] = useState<TurnOption["id"] | null>(null);
  const known = useRef<Set<string> | null>(null);

  if (board.isPending) return <Loading page />;
  if (board.error) return <ErrorBox error={board.error} onRetry={() => board.refetch()} />;
  const { plan, adopted, week, applied } = board.data;
  const reviewer = can.reviewFindings(role);
  const open = plan.options;
  const option = open.find((o) => o.id === picked) ?? open[0] ?? null;

  const measures = new Map(adopted.measures.map((m) => [m.id, m]));
  const cards: AdoptedOption[] = applied.flatMap((a) => {
    const rows = a.measureIds.flatMap((id) => measures.get(id) ?? []);
    return rows.length ? [{ ...a, rows }] : [];
  });
  known.current ??= new Set(cards.map((c) => c.turnId));
  const rank = (x: AdoptedOption | TurnOption) => ORDER.indexOf("turnId" in x ? x.option : x.id);
  const slots = [...cards, ...open].sort((a, b) => rank(a) - rank(b));

  // an on-site check holds findings but switches nothing, so it is no part of what is expected to be saved
  const saving = adopted.measures.filter((m) => m.strategyId !== "investigate_on_site");
  const showing = priority ? [priority] : (option?.actions ?? []);
  const covered = plan.adoptedKwh + coveredBy(showing);
  const figures = rangeOf(plan.recorded, covered, plan.realisation);
  const acted = new Set([...saving.map((m) => m.floorId), ...showing.map((a) => a.floorId)]);
  const bottomUp = [...(overview.data?.floors ?? [])].reverse();
  const any = saving.length > 0;

  const adopt = (o: TurnOption) => {
    if (o.id === "community") return;
    actions.adopt.mutate(o.id, {
      // on a phone the button under the panel is a long way from the total it has just added to
      onSuccess: () =>
        requestAnimationFrame(() =>
          document.getElementById("adopted-so-far")?.scrollIntoView({ behavior: glide(), block: "center" }),
        ),
    });
  };

  return (
    <div className="space-y-6">
      <Card title={t.strategies.compare}>
        <p className="text-xs text-muted">{t.strategies.compareHint}</p>
        <Limits asker={can.explain(role)} reviewer={reviewer} />
        {any ? <AdoptedSoFar plan={plan} after={adopted.after} count={saving.length} /> : null}
        {slots.length ? (
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
            {slots.map((slot) =>
              "turnId" in slot ? (
                <AdoptedCard
                  key={slot.turnId}
                  plan={plan}
                  card={slot}
                  fresh={!known.current?.has(slot.turnId)}
                  reviewer={reviewer}
                  undo={actions.undo}
                />
              ) : (
                <OpenCard
                  key={slot.id}
                  plan={plan}
                  option={slot}
                  rest={cards.some((c) => c.option === slot.id)}
                  selected={!priority && slot.id === option?.id}
                  reviewer={reviewer}
                  adopt={actions.adopt}
                  onSelect={() => {
                    if (priority || slot.id !== option?.id) tick();
                    setPicked(slot.id);
                    onPick();
                  }}
                  onAdopt={() => adopt(slot)}
                />
              ),
            )}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">
            {t.assistant.nothingOpen}{" "}
            <Link
              href={`/o/${orgId}/b/${buildingId}/findings`}
              className="inline-flex min-h-11 items-center font-medium text-accent"
            >
              {t.strategies.seeOpportunities}
            </Link>
          </p>
        )}
        {actions.adopt.error ? (
          <div className="mt-3">
            <ErrorBox error={actions.adopt.error} />
          </div>
        ) : null}
      </Card>

      {slots.length ? (
        <section id="strategy-panel" className="scroll-mt-[calc(var(--app-top)+72px)]">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">
              {priority?.title ??
                (option ? (t.assistant.options[option.id] ?? option.id) : t.strategies.adoptedSoFar)}
            </h2>
            {priority || option ? <Badge tone="accent">{t.split.previewing}</Badge> : null}
            {(priority || option) && any ? (
              <span className="text-xs text-muted">{t.strategies.onTop}</span>
            ) : null}
          </div>
          <SplitPanel
            plan={plan}
            before={plan.recorded}
            figures={figures}
            acted={acted}
            floors={bottomUp}
            live={liveFloors(bottomUp)}
          />
          {priority ? (
            <p className="mt-3 text-xs text-muted">{t.strategies.fromOverview}</p>
          ) : option && reviewer ? (
            <Button
              variant="primary"
              className="mt-3 min-h-11 sm:min-h-9"
              disabled={actions.adopt.isPending}
              busy={actions.adopt.isPending && actions.adopt.variables === option.id}
              onClick={() => adopt(option)}
            >
              {t.strategies.adoptThis}
            </Button>
          ) : null}
        </section>
      ) : null}

      <WeekAhead plan={plan} week={week} option={priority ? null : option} />
    </div>
  );
}
