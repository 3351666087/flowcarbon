"use client";

import { compareOrder } from "@flowcarbon/core/portfolio";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Plus } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Segmented } from "@/components/auth-code";
import { buildingLabel } from "@/components/shell";
import { Badge, Card, Empty, ErrorBox, Loading, Metric, PageHeader, Select, Table } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { paths } from "@/lib/api-types";
import { addDays, kwh, num, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, useIds, useMembership } from "@/lib/session";

type Compare = paths["/api/v1/orgs/{orgId}/compare"]["get"]["responses"][200]["content"]["application/json"];
type Row = Compare["buildings"][number];

const WINDOWS = ["7", "28", "90"] as const;
type WindowKey = (typeof WINDOWS)[number];

const SORTS = [
  "afterHoursChange",
  "intensity",
  "afterHoursShare",
  "avoidableShare",
  "saved",
  "name",
] as const;
type SortKey = (typeof SORTS)[number];
const SORT: Record<SortKey, { key: (r: Row) => number | string | null; dir: "asc" | "desc" }> = {
  afterHoursChange: { key: (r) => r.change.afterHoursPerDayPct, dir: "asc" },
  intensity: { key: (r) => r.current.kwhPerM2Day, dir: "asc" },
  afterHoursShare: { key: (r) => r.current.afterHoursShare, dir: "asc" },
  avoidableShare: { key: (r) => r.current.avoidableShare, dir: "desc" },
  saved: { key: (r) => (r.measures.measured ? r.measures.measuredWeeklyKwh : null), dir: "desc" },
  name: { key: (r) => r.name, dir: "asc" },
};

export default function ComparePage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const membership = useMembership();
  const [win, setWin] = useState<WindowKey>("28");
  const [sort, setSort] = useState<SortKey>("afterHoursChange");
  const days = Number(win);

  const q = useQuery({
    queryKey: ["compare", orgId, days],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/compare", { params: { path: { orgId }, query: { days } } })),
    // two reports and the measures of every building: no need to ask again on every visit
    staleTime: 5 * 60_000,
  });

  const day = (key: string) =>
    new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${key}T00:00:00Z`));
  const signed = (v: number, digits = 1) =>
    `${v > 0 ? "+" : v < 0 ? "−" : "±"}${num(Math.abs(v), locale, digits)}`;
  /** a change, or a dash that says why there is none */
  const change = (v: number | null, unit: "pct" | "pp") =>
    v === null ? (
      <span className="text-muted" title={t.compare.notEnough}>
        —
      </span>
    ) : (
      <span className={clsx("num", v < 0 ? "text-saving" : v > 0 ? "text-waste" : "text-muted")}>
        {unit === "pct" ? `${signed(v)} %` : fill(t.compare.pp, { value: signed(v) })}
      </span>
    );
  const intensity = (v: number | null) => (v === null ? "–" : num(v, locale, 3));

  const header = (sub: string) => (
    <PageHeader
      title={t.compare.title}
      subtitle={sub}
      actions={
        <div className="w-56">
          <Segmented
            label={t.compare.windowLabel}
            value={win}
            onChange={setWin}
            options={WINDOWS.map((k) => ({ key: k, label: fill(t.compare.windowDays, { n: k }) }))}
          />
        </div>
      }
    />
  );

  if (q.isPending)
    return (
      <>
        {header(fill(t.compare.sub, { days }))}
        <Loading page />
      </>
    );
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  const w = data.window;
  const range = fill(t.compare.window, { from: day(w.from), to: day(addDays(w.to, -1)) });
  const previous = fill(t.compare.previous, {
    from: day(w.previousFrom),
    to: day(addDays(w.previousTo, -1)),
  });
  const covered = (n: number) => fill(t.compare.days, { n, d: w.days });

  const saved = (r: Row) => {
    const m = r.measures;
    if (!m.inEffect) return <span className="text-muted">{t.compare.noMeasures}</span>;
    return (
      <div className="flex flex-col gap-1">
        {m.measured ? (
          <span
            className="flex flex-wrap items-center gap-1.5"
            title={fill(t.compare.toDate, { kwh: kwh(m.measuredToDateKwh, locale) })}
          >
            <Badge tone="accent">{t.measures.measured}</Badge>
            <span className="num">
              {fill(t.compare.measuredLine, { kwh: kwh(m.measuredWeeklyKwh, locale), n: m.measured })}
            </span>
          </span>
        ) : null}
        {m.expectedInEffect ? (
          <span
            className="flex flex-wrap items-center gap-1.5"
            title={fill(t.compare.range, {
              low: kwh(m.expectedLowKwh, locale),
              high: kwh(m.expectedHighKwh, locale),
              days: m.expectedDays,
            })}
          >
            <span className="inline-flex items-center whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted">
              {t.measures.expected}
            </span>
            <span className="num">
              {fill(t.compare.expectedLine, { kwh: kwh(m.expectedWeeklyKwh, locale), n: m.expectedInEffect })}
            </span>
          </span>
        ) : null}
      </div>
    );
  };

  const notes = (
    <div className="mt-4 flex flex-col gap-1 text-xs text-muted">
      {data.simulated ? <p>{t.compare.simulated}</p> : null}
      <p>{t.compare.intensityHint}</p>
      <p>{t.compare.area}</p>
      {data.truncated ? <p>{fill(t.compare.truncated, { n: data.buildings.length })}</p> : null}
    </div>
  );
  const simulatedBadge = data.simulated ? <Badge tone="waste">{t.simulated}</Badge> : null;

  // ---- one building: against its own previous window --------------------------------------------------------
  if (data.buildings.length <= 1) {
    const r = data.buildings[0];
    const canAdd = can.manageOrg(membership?.role) && !data.simulated;
    const vs = (node: ReactNode) => (
      <span>
        {fill(t.compare.previousWindow, { days: w.days })}: {node}
      </span>
    );
    return (
      <>
        {header(fill(t.compare.subOne, { days }))}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="num">{range}</span>
          <span>·</span>
          <span className="num">{previous}</span>
          {simulatedBadge}
        </div>
        {r ? (
          <>
            {r.current.days === 0 ? (
              <Empty>
                {t.compare.noData}
                {r.lastDataDay ? ` · ${fill(t.compare.lastData, { date: r.lastDataDay })}` : null}
              </Empty>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric
                  label={t.compare.intensity}
                  value={intensity(r.current.kwhPerM2Day)}
                  sub={vs(change(r.change.kwhPerM2DayPct, "pct"))}
                />
                <Metric
                  label={t.compare.afterHoursPerDay}
                  value={r.current.afterHoursPerDay === null ? "–" : kwh(r.current.afterHoursPerDay, locale)}
                  sub={vs(change(r.change.afterHoursPerDayPct, "pct"))}
                />
                <Metric
                  label={t.compare.afterHoursShare}
                  value={pct(r.current.afterHoursShare, locale)}
                  sub={vs(change(r.change.afterHoursSharePp, "pp"))}
                />
                <Metric
                  label={t.compare.avoidableShare}
                  value={pct(r.current.avoidableShare, locale)}
                  sub={vs(change(r.change.avoidableSharePp, "pp"))}
                />
              </div>
            )}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <Card title={t.compare.saved}>{saved(r)}</Card>
              <Card title={t.compare.dataDays}>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="num">
                    {range}: {covered(r.current.days)}
                  </span>
                  <span className="num text-muted">
                    {fill(t.compare.previousWindow, { days: w.days })}: {covered(r.previous.days)}
                  </span>
                </div>
              </Card>
            </div>
          </>
        ) : null}
        <div className="mt-4">
          <Empty>
            <p>{data.simulated ? t.compare.demoOne : t.compare.addMore}</p>
            {canAdd ? (
              <Link
                href={`/o/${orgId}/setup`}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-surface-2 sm:h-9 sm:min-h-0"
              >
                <Plus className="size-4" aria-hidden /> {t.compare.addBuilding}
              </Link>
            ) : null}
          </Empty>
        </div>
        {notes}
      </>
    );
  }

  // ---- several buildings, side by side ------------------------------------------------------------------------
  const rows = compareOrder(data.buildings, SORT[sort].key, SORT[sort].dir);
  return (
    <>
      {header(fill(t.compare.sub, { days }))}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="num">{range}</span>
          <span>·</span>
          <span className="num">{previous}</span>
          {simulatedBadge}
        </div>
        <label htmlFor="compare-sort" className="flex items-center gap-2 text-sm text-muted">
          {t.compare.sortBy}
          <Select
            id="compare-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="w-auto"
          >
            {SORTS.map((k) => (
              <option key={k} value={k}>
                {t.compare.sort[k]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <Card pad>
        <Table
          minWidth={880}
          head={[
            t.compare.building,
            t.compare.intensity,
            t.compare.afterHoursShare,
            t.compare.afterHoursChange,
            t.compare.avoidableShare,
            t.compare.saved,
            t.compare.dataDays,
          ]}
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/o/${orgId}/b/${r.id}/floors`} className="font-medium hover:text-accent">
                  {buildingLabel(r.name)}
                </Link>
                {r.id === buildingId ? (
                  <span className="ml-2">
                    <Badge>{t.compare.current}</Badge>
                  </span>
                ) : null}
              </td>
              <td title={t.compare.intensityHint}>
                <div className="num">{intensity(r.current.kwhPerM2Day)}</div>
                <div className="text-xs">{change(r.change.kwhPerM2DayPct, "pct")}</div>
              </td>
              <td>
                <div className="num">{pct(r.current.afterHoursShare, locale)}</div>
                <div className="text-xs">{change(r.change.afterHoursSharePp, "pp")}</div>
              </td>
              <td title={t.compare.afterHoursChangeHint}>
                {change(r.change.afterHoursPerDayPct, "pct")}
                <div className="num text-xs text-muted">
                  {r.current.afterHoursPerDay === null ? "–" : kwh(r.current.afterHoursPerDay, locale)}
                </div>
              </td>
              <td>
                <div className="num">{pct(r.current.avoidableShare, locale)}</div>
                <div className="text-xs">{change(r.change.avoidableSharePp, "pp")}</div>
              </td>
              <td>{saved(r)}</td>
              <td>
                <div className="num">{covered(r.current.days)}</div>
                {r.current.days === 0 && r.lastDataDay ? (
                  <div className="text-xs text-muted">
                    {fill(t.compare.lastData, { date: r.lastDataDay })}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      {notes}
    </>
  );
}
