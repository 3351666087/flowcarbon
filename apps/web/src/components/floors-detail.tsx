"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Lightbulb, Moon, Snowflake, Users } from "lucide-react";
import Link from "next/link";
import { DailyEnergyChart } from "@/components/charts";
import { Badge, Card, Empty, ErrorBox, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { addDays, dateTime, day, kwh, num, pct, todayIn } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { compareNights, NIGHT_HIGH_SHARE } from "@/lib/night-compare";
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
  // who controls each floor's energy over the same days (by system, not by metered area)
  // a day whose split by system is not known counts as neither party's, and the line says how much that is
  const party = new Map<string, { tenant: number; building: number; unsplit: number }>();
  for (const r of daily.data ?? []) {
    const p = party.get(r.floorId) ?? { tenant: 0, building: 0, unsplit: 0 };
    if (r.systemsSplit) {
      p.tenant += r.kwhTenant ?? 0;
      p.building += r.kwhBuilding ?? 0;
    } else p.unsplit += r.kwhTotal;
    party.set(r.floorId, p);
  }
  const partyDays = byDay.size;
  const partyLine = (floorId: string) => {
    const p = party.get(floorId);
    const total = p ? p.tenant + p.building + p.unsplit : 0;
    if (!p || total <= 0) return null;
    const share = (v: number) => pct(v / total, locale);
    const unsplit = p.unsplit > 0 ? fill(t.floors.partyUnsplit, { share: share(p.unsplit) }) : null;
    if (p.tenant + p.building <= 0) return unsplit;
    // "Building 100 %" only when all of it really is the building's
    const split =
      p.tenant > 0 || p.unsplit > 0
        ? fill(t.floors.partySplit, { tenant: share(p.tenant), building: share(p.building), days: partyDays })
        : fill(t.floors.partyVacant, { days: partyDays });
    return unsplit ? `${split} · ${unsplit}` : split;
  };
  const nights = daily.data ? compareNights(daily.data, asOf, todayIn(tz)) : null;
  const floorById = new Map(o.floors.map((f) => [f.floorId, f]));
  // a floor's night is often a few kWh: one decimal below ten, so a small change does not read as nothing
  const nightKwh = (v: number) => (Math.abs(v) < 10 ? `${num(v, locale, 1)} kWh` : kwh(v, locale));
  const signed = (v: number, text: string) =>
    v > 0 ? `+${text}` : v < 0 ? `−${text.replace(/^-/, "")}` : text;

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
                  {partyLine(f.floorId) ? (
                    <div className="truncate text-xs text-muted" title={t.floors.partyNote}>
                      {partyLine(f.floorId)}
                    </div>
                  ) : null}
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

      {nights?.floors.length ? (
        <Card title={t.floors.night} pad={false} className="mb-6">
          <p className="px-4 pt-3 text-xs text-muted">
            {fill(t.floors.nightNote, {
              latest: day(nights.latest, locale),
              prior: day(nights.prior, locale),
              share: pct(NIGHT_HIGH_SHARE, locale),
            })}
          </p>
          <ul className="divide-y divide-border">
            {nights.floors.map((n) => {
              const f = floorById.get(n.floorId);
              return (
                <li
                  key={n.floorId}
                  className={clsx(
                    "grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[4rem_1.4fr_repeat(2,minmax(0,1fr))_auto]",
                    n.high && "bg-waste-soft/40",
                  )}
                >
                  <div className="text-lg font-semibold">{f?.label ?? "–"}</div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {f?.tenantId ? (tenantName.get(f.tenantId) ?? "–") : t.common.vacant}
                    </div>
                    {/* on a phone the two days sit under the name; wider, they get columns of their own */}
                    <div className="num text-xs text-muted sm:hidden">
                      {nightKwh(n.latest)} · {t.floors.nightPrior}{" "}
                      {n.prior === null ? "–" : nightKwh(n.prior)}
                    </div>
                  </div>
                  <div className="hidden text-sm sm:block">
                    <div className="num font-medium">{nightKwh(n.latest)}</div>
                    <div className="text-xs text-muted">{t.floors.nightLatest}</div>
                  </div>
                  <div className="hidden text-sm sm:block">
                    <div className="num">{n.prior === null ? "–" : nightKwh(n.prior)}</div>
                    <div className="text-xs text-muted">{t.floors.nightPrior}</div>
                  </div>
                  <div className="text-right">
                    {n.delta === null ? (
                      <div className="text-xs text-muted">{t.floors.nightNoPrior}</div>
                    ) : (
                      <>
                        <div
                          className={clsx(
                            "num text-sm font-medium",
                            n.high ? "text-waste" : n.delta < 0 ? "text-saving" : undefined,
                          )}
                        >
                          {signed(n.delta, nightKwh(n.delta))}
                        </div>
                        <div className="num text-xs text-muted">
                          {n.share === null ? "–" : signed(n.share, pct(n.share, locale))}
                        </div>
                      </>
                    )}
                    {n.high ? (
                      <div className="mt-1">
                        <Badge tone="waste">
                          <Moon className="size-3" aria-hidden />
                          {t.floors.nightHigh}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

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
