"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Lightbulb, Snowflake, Users } from "lucide-react";
import Link from "next/link";
import { DailyEnergyChart } from "@/components/charts";
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

  if (overview.isPending) return <Loading />;
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
            {o.floors.map((f) => (
              <li
                key={f.floorId}
                className={clsx(
                  "grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[4rem_1.4fr_repeat(3,minmax(0,1fr))_auto]",
                  f.wasteNow && "bg-waste-soft/40",
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
