"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Lightbulb, Snowflake, Users } from "lucide-react";
import Link from "next/link";
import { DailyEnergyChart } from "@/components/charts";
import { Badge, Card, Empty, ErrorBox, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { addDays, dateTime, kwh, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { useBuilding, useIds, useMembership, useTenants } from "@/lib/session";

/**
 * Every floor as it is now, and the building's last four weeks day by day. On the data page for the team, and on the
 * first page for a tenant, who has no data page. Where a tower stands above it (`onPick`), tapping a floor in the list
 * lights it up there.
 */
export function FloorsDetail({
  picked = null,
  onPick,
}: {
  picked?: number | null;
  onPick?: (index: number) => void;
}) {
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

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-semibold">{t.floors.detail}</h2>
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
                onClick={onPick ? () => onPick(o.floors.length - 1 - row) : undefined}
                className={clsx(
                  "grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[4rem_1.4fr_repeat(3,minmax(0,1fr))_auto]",
                  onPick && "cursor-pointer",
                  f.wasteNow && "bg-waste-soft/40",
                  picked === o.floors.length - 1 - row && "bg-accent-soft/60",
                )}
              >
                <div className="text-lg font-semibold">{f.label}</div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {f.tenantId ? (tenantName.get(f.tenantId) ?? "–") : t.common.vacant}
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
                    <div className="text-xs text-muted">
                      {fill(t.floors.avoidable, { days: overview.data?.last28?.days ?? 28 })}
                    </div>
                  </div>
                  {f.openFindings > 0 && role !== "tenant_admin" ? (
                    <Link
                      href={`/o/${orgId}/b/${buildingId}/findings?floorId=${f.floorId}`}
                      className="inline-flex min-h-11 items-center"
                    >
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
    </section>
  );
}
