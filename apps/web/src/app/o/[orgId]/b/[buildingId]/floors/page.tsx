"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Lightbulb, Snowflake, Users } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { DailyEnergyChart } from "@/components/charts";
import { tick } from "@/components/glass";
import { TowerScene } from "@/components/tower-scene";
import { Badge, Card, Empty, ErrorBox, Loading, Metric, PageHeader } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { addDays, co2, dateTime, kwh, money, pct } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useBuilding, useIds, useMembership, useTenants } from "@/lib/session";

export default function FloorsPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const tenants = useTenants();
  const [picked, setPicked] = useState<number | null>(null);
  const hero = useRef<HTMLDivElement>(null);
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
  const asOf = overview.data?.asOf;
  const daily = useQuery({
    queryKey: ["daily", orgId, buildingId, asOf],
    enabled: !!asOf,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/daily", {
          params: {
            path: { orgId, buildingId },
            query: { from: addDays(asOf!, -27), to: addDays(asOf!, 1) },
          },
        }),
      ),
  });

  if (overview.isPending) return <Loading page />;
  if (overview.error) return <ErrorBox error={overview.error} onRetry={() => overview.refetch()} />;
  const o = overview.data;
  const tz = building!.timezone;
  const tenantName = new Map((tenants.data ?? []).map((x) => [x.id, x.name]));
  const byDay = new Map<string, { day: string; kwh: number; avoidable: number }>();
  for (const r of daily.data ?? []) {
    const d = byDay.get(r.day) ?? { day: r.day, kwh: 0, avoidable: 0 };
    d.kwh += r.kwhTotal;
    d.avoidable += r.avoidableKwh;
    byDay.set(r.day, d);
  }
  const l = o.last28;
  // the tower is drawn bottom up; the list reads top down
  const bottomUp = [...o.floors].reverse();
  const crowd = Math.max(20, ...o.floors.map((f) => f.occupancy));
  const live = bottomUp.map((f) => ({ occ: Math.min(1, f.occupancy / crowd), waste: f.wasteNow }));
  const inBuilding = o.floors.reduce((n, f) => n + f.occupancy, 0);
  const wasting = o.floors.filter((f) => f.wasteNow).length;
  const chosen = picked === null ? null : bottomUp[picked];
  const pick = (index: number) => {
    tick();
    setPicked((p) => (p === index ? null : index));
  };

  return (
    <>
      <PageHeader
        title={t.floors.title}
        subtitle={t.floors.subtitle}
        actions={
          asOf ? (
            <span className="text-xs text-muted">
              {t.floors.asOf} {asOf}
            </span>
          ) : null
        }
      />

      {o.floors.length ? (
        <div
          ref={hero}
          className="relative mb-6 h-[300px] overflow-hidden rounded-2xl border border-border bg-surface sm:h-[340px]"
        >
          <TowerScene
            className="absolute inset-0 size-full [--tower-scale:1.2] [--tower-y:0.5] sm:[--tower-x:0.62]"
            live={live}
            picked={picked}
            onPick={pick}
          />
          <div className="pointer-events-none absolute top-4 left-4">
            <div className="text-xs text-muted">
              {t.floors.now}
              {o.floors[0]?.at
                ? ` · ${dateTime(o.floors[0].at, locale, tz, { dateStyle: undefined, timeStyle: "short" })}`
                : ""}
            </div>
            <div className="num mt-0.5 text-3xl font-semibold tracking-tight">
              {inBuilding} <span className="text-sm font-normal text-muted">{t.floors.inBuilding}</span>
            </div>
            {wasting ? (
              <div className="mt-1 text-xs font-medium text-waste">
                {wasting} {t.floors.wastingFloors}
              </div>
            ) : null}
          </div>
          {chosen ? (
            <div className="fc-glass fc-glass-strong fc-rise absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-2xl p-3 sm:right-auto sm:w-[360px]">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-[15px] font-semibold">
                {chosen.label}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {chosen.tenantId ? (tenantName.get(chosen.tenantId) ?? "—") : t.common.vacant}
                </span>
                <span className="mt-0.5 flex items-center gap-2.5 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" aria-hidden />
                    <span className="num">{chosen.occupancy}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Snowflake
                      className={clsx("size-3.5", chosen.hvacMode !== "off" && "text-accent")}
                      aria-hidden
                    />
                    {t.floors.hvacMode[chosen.hvacMode] ?? chosen.hvacMode}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Lightbulb
                      className={clsx("size-3.5", chosen.lightsOn >= 0.2 && "text-waste")}
                      aria-hidden
                    />
                    {pct(chosen.lightsOn, locale)}
                  </span>
                </span>
              </span>
              {chosen.openFindings > 0 && role !== "tenant_admin" ? (
                <Link
                  href={`/o/${orgId}/b/${buildingId}/findings?floorId=${chosen.floorId}`}
                  className="fc-press flex shrink-0 items-center gap-0.5 rounded-full bg-waste-soft py-1 pr-1.5 pl-2.5 text-xs font-medium text-waste"
                >
                  {chosen.openFindings} {t.floors.open}
                  <ChevronRight className="size-3.5" aria-hidden />
                </Link>
              ) : (
                <span className="num shrink-0 text-right text-xs text-muted">
                  {kwh(chosen.avoidableKwh28d, locale)}
                  <br />
                  {t.floors.avoidable}
                </span>
              )}
            </div>
          ) : (
            <div className="pointer-events-none absolute bottom-3 left-4 text-xs text-muted">
              {t.floors.tapHint}
            </div>
          )}
        </div>
      ) : null}

      {l ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Metric
            label={t.floors.energy28}
            value={kwh(l.kwh, locale)}
            sub={money(l.cost, locale, building!.currency)}
          />
          <Metric
            label={t.floors.avoidable28}
            value={kwh(l.avoidableKwh, locale)}
            tone="waste"
            sub={`${money(l.avoidableCost, locale, building!.currency)} · ${pct(l.avoidableShare, locale)}`}
          />
          <Metric label={t.floors.scope2} value={co2(l.co2eKg, locale)} />
          <Metric
            label={t.floors.measuredShare}
            value={pct(l.measuredShare, locale)}
            sub={`${t.common.measured} / ${t.common.estimated}`}
            tone="accent"
          />
          <Metric label={t.floors.greenShare} value={pct(l.greenShare, locale, 1)} tone="saving" />
        </div>
      ) : null}

      <Card title={t.floors.now} pad={false} className="mb-6">
        {o.floors.length === 0 ? (
          <div className="p-4">
            <Empty>{t.common.noData}</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {o.floors.map((f, row) => (
              // tapping a floor in the list lights it up in the tower
              // biome-ignore lint/a11y/useKeyWithClickEvents: the same floor is reachable in the tower and by its findings link
              <li
                key={f.floorId}
                onClick={() => {
                  pick(o.floors.length - 1 - row);
                  hero.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }}
                className={clsx(
                  "grid cursor-pointer grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[4rem_1.4fr_repeat(3,minmax(0,1fr))_auto]",
                  f.wasteNow && "bg-waste-soft/40",
                  picked === o.floors.length - 1 - row && "bg-accent-soft/60",
                )}
              >
                <div className="text-lg font-semibold">{f.label}</div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {f.tenantId ? (tenantName.get(f.tenantId) ?? "—") : t.common.vacant}
                  </div>
                  {f.wasteNow ? (
                    <div className="text-xs font-medium text-waste">{t.floors.wasteNow}</div>
                  ) : (
                    <div className="text-xs text-muted">
                      {f.at ? dateTime(f.at, locale, tz, { dateStyle: undefined, timeStyle: "short" }) : "–"}
                    </div>
                  )}
                </div>
                <div className="hidden items-center gap-1.5 text-sm sm:flex" title={t.common.people}>
                  <Users className="size-4 text-muted" aria-hidden />
                  <span className="num">{f.occupancy}</span>
                </div>
                <div className="hidden items-center gap-1.5 text-sm sm:flex">
                  <Snowflake
                    className={clsx("size-4", f.hvacMode === "off" ? "text-muted" : "text-accent")}
                    aria-hidden
                  />
                  {t.floors.hvacMode[f.hvacMode] ?? f.hvacMode}
                </div>
                <div className="hidden items-center gap-1.5 text-sm sm:flex">
                  <Lightbulb
                    className={clsx("size-4", f.lightsOn >= 0.2 ? "text-waste" : "text-muted")}
                    aria-hidden
                  />
                  {pct(f.lightsOn, locale)}
                </div>
                <div className="flex items-center justify-end gap-2 text-right">
                  <div>
                    <div className="num text-sm font-medium">{kwh(f.avoidableKwh28d, locale)}</div>
                    <div className="text-xs text-muted">{t.floors.avoidable}</div>
                  </div>
                  {f.openFindings > 0 && role !== "tenant_admin" ? (
                    <Link href={`/o/${orgId}/b/${buildingId}/findings?floorId=${f.floorId}`}>
                      <Badge tone="waste">
                        {f.openFindings} {t.floors.open}
                      </Badge>
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t.floors.daily}>
        {daily.isPending ? (
          <Loading />
        ) : byDay.size ? (
          <DailyEnergyChart
            data={[...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))}
            locale={locale}
            labels={{ energy: t.report.energy, avoidable: t.report.avoidable }}
          />
        ) : (
          <Empty>{t.common.noData}</Empty>
        )}
      </Card>
    </>
  );
}
