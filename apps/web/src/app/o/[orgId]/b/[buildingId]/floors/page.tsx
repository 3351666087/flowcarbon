"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Lightbulb, Snowflake, Users } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";
import { Assistant, glide, type ShareTarget, type SplitView } from "@/components/assistant";
import { BeforeAfter } from "@/components/before-after";
import { CommunityRail, ShareDialog } from "@/components/community-rail";
import { FirstUse, FirstUseLink, useFirstUse } from "@/components/first-use";
import { FloorsDetail } from "@/components/floors-detail";
import { tick } from "@/components/glass";
import { liveFloors, TowerScene } from "@/components/tower-scene";
import { ErrorBox, Loading, Metric, PageHeader } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { useHistoryView } from "@/lib/back";
import { co2, dateTime, kwh, money, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { PAGES, useBuilding, useIds, useMembership, useTenants } from "@/lib/session";

export default function FloorsPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const tenants = useTenants();
  const [picked, setPicked] = useState<number | null>(null);
  // an option on show, which splits the top of the page in two; back to where it stood on the page once it closes
  const [split, setSplit, closeSplit] = useHistoryView<SplitView>((view) => {
    const anchor = `option-${view.turnId ?? "board"}-${view.optionId}`;
    requestAnimationFrame(() =>
      document.getElementById(anchor)?.scrollIntoView({ behavior: glide(), block: "center" }),
    );
  });
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  // on a phone the floor card lies over the bottom of the scene, so the tower moves up to stay clear of it
  const narrow = useSyncExternalStore(
    (change) => {
      const q = matchMedia("(max-width: 639px)");
      q.addEventListener("change", change);
      return () => q.removeEventListener("change", change);
    },
    () => matchMedia("(max-width: 639px)").matches,
    () => false,
  );
  const hero = useRef<HTMLDivElement>(null);
  const assistant = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const guide = useFirstUse();
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

  if (overview.isPending) return <Loading page />;
  if (overview.error) return <ErrorBox error={overview.error} onRetry={() => overview.refetch()} />;
  const o = overview.data;
  const tz = building!.timezone;
  const tenantName = new Map((tenants.data ?? []).map((x) => [x.id, x.name]));
  const l = o.last28;
  // the tower is drawn bottom up; the list reads top down
  const bottomUp = [...o.floors].reverse();
  const live = liveFloors(bottomUp);
  const inBuilding = o.floors.reduce((n, f) => n + f.occupancy, 0);
  // a floor with no reading is a floor nobody knows about, not an empty one
  const reading = o.floors.some((f) => f.at);
  const days = l?.days ?? 28;
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
        subtitle={fill(t.floors.subtitle, { days })}
        actions={
          <span className="flex flex-wrap items-center gap-x-3">
            {guide.shown ? null : <FirstUseLink onClick={guide.show} />}
            {asOf ? (
              <span className="text-xs text-muted">
                {t.floors.asOf} {asOf}
              </span>
            ) : null}
          </span>
        }
      />

      {guide.shown ? (
        <FirstUse
          onDone={guide.hide}
          onTower={() => {
            tick();
            // the tower, or with an option on show (which takes its place) the floor list a tenant sees
            (hero.current ?? list.current)?.scrollIntoView({ behavior: glide(), block: "start" });
          }}
          onAssistant={
            role === "tenant_admin"
              ? undefined
              : () => {
                  tick();
                  assistant.current?.scrollIntoView({ behavior: glide(), block: "start" });
                }
          }
        />
      ) : null}

      {split ? (
        <BeforeAfter
          view={split}
          floors={bottomUp}
          live={live}
          onChange={setSplit}
          onClose={closeSplit}
          onShare={setSharing}
        />
      ) : null}

      {!split && o.floors.length ? (
        <div
          ref={hero}
          className="relative mb-6 h-[300px] overflow-hidden rounded-2xl border border-border bg-surface sm:h-[340px]"
        >
          <TowerScene
            className="absolute inset-0 size-full [--tower-scale:1.2] [--tower-y:0.5] sm:[--tower-x:0.62]"
            live={live}
            picked={picked}
            onPick={pick}
            reserveBottom={chosen && narrow ? 88 : 0}
          />
          <div className="pointer-events-none absolute top-4 left-4">
            <div className="text-xs text-muted">
              {t.floors.now}
              {o.floors[0]?.at
                ? ` · ${dateTime(o.floors[0].at, locale, tz, { dateStyle: undefined, timeStyle: "short" })}`
                : ""}
            </div>
            {reading ? (
              <div className="num mt-0.5 text-3xl font-semibold tracking-tight">
                {inBuilding} <span className="text-sm font-normal text-muted">{t.floors.inBuilding}</span>
              </div>
            ) : (
              <div className="mt-1 text-sm font-medium">
                {asOf ? fill(t.floors.noReadingUntil, { date: asOf }) : t.floors.noReading}
              </div>
            )}
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
                  {chosen.tenantId ? (tenantName.get(chosen.tenantId) ?? "–") : t.common.vacant}
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
                  {fill(t.floors.avoidable, { days })}
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

      {!asOf ? (
        <div className="mb-6 rounded-2xl bg-surface-2 p-4 text-sm">
          <p>{t.floors.noData}</p>
          {role && PAGES.data?.includes(role) ? (
            <Link
              href={`/o/${orgId}/b/${buildingId}/data`}
              className="mt-1 inline-flex min-h-11 items-center gap-0.5 font-medium text-accent sm:min-h-0"
            >
              {t.floors.toData} <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : null}

      {!split && l ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Metric
            label={fill(t.floors.energy28, { days })}
            value={kwh(l.kwh, locale)}
            sub={money(l.cost, locale, building!.currency)}
          />
          <Metric
            label={fill(t.floors.avoidable28, { days })}
            value={kwh(l.avoidableKwh, locale)}
            tone="waste"
            sub={`${money(l.avoidableCost, locale, building!.currency)} · ${pct(l.avoidableShare, locale, 1)}`}
          />
          <Metric label={t.floors.scope2} value={co2(l.co2eKg, locale)} />
          <Metric
            label={t.floors.measuredShare}
            value={pct(l.measuredShare, locale, 1)}
            sub={`${t.common.measured} / ${t.common.estimated}`}
            tone="accent"
          />
          <Metric label={t.floors.greenShare} value={pct(l.greenShare, locale, 1)} tone="saving" />
        </div>
      ) : null}

      {role === "tenant_admin" ? (
        <>
          <p className="mb-6 text-sm text-muted">{t.assistant.tenantNote}</p>
          <div ref={list} className="scroll-mt-24">
            <FloorsDetail
              picked={picked}
              onPick={(index) => {
                pick(index);
                hero.current?.scrollIntoView({ behavior: glide(), block: "nearest" });
              }}
            />
          </div>
        </>
      ) : (
        <div
          ref={assistant}
          className="grid scroll-mt-24 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]"
        >
          <Assistant noData={!asOf} onOpen={setSplit} onShare={setSharing} />
          <CommunityRail onShare={setSharing} onPreview={setSplit} />
        </div>
      )}
      {sharing ? <ShareDialog target={sharing} onClose={() => setSharing(null)} /> : null}
    </>
  );
}
