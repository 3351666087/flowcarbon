"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, CircleAlert, CircleCheck, Lightbulb, Snowflake, Users, WifiOff } from "lucide-react";
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

/** how recent the newest floor reading has to be for the page to speak of "now" */
const LIVE_MS = 2 * 60 * 60 * 1000;

export default function FloorsPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const membership = useMembership();
  const role = membership?.role;
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
  const days = l?.days ?? 28;
  const chosen = picked === null ? null : bottomUp[picked];
  const pick = (index: number) => {
    tick();
    setPicked((p) => (p === index ? null : index));
  };
  // each floor on the tower is named as the card names it: its label and who is on it
  const names = bottomUp.map(
    (f) => `${f.label} · ${f.tenantId ? (tenantName.get(f.tenantId) ?? "–") : t.common.vacant}`,
  );

  // the one line on top: whether anything needs adjusting now. "Now" only holds while readings are recent; a
  // building whose latest reading is older is shown as having no live data, not as fine.
  const latestAt = o.floors.reduce<string | null>((m, f) => (f.at && (!m || f.at > m) ? f.at : m), null);
  const fresh = latestAt !== null && Date.now() - Date.parse(latestAt) < LIVE_MS;
  const wastingNow = fresh ? o.floors.filter((f) => f.wasteNow) : [];
  // the worst of them: the most avoidable energy over the window, then the most open findings
  const worst = wastingNow.reduce<(typeof o.floors)[number] | null>(
    (w, f) =>
      !w ||
      f.avoidableKwh28d > w.avoidableKwh28d ||
      (f.avoidableKwh28d === w.avoidableKwh28d && f.openFindings > w.openFindings)
        ? f
        : w,
    null,
  );
  const showData = !!role && !!PAGES.data?.includes(role);
  const status: {
    tone: "waste" | "saving" | "muted";
    text: string;
    sub?: string;
    action?: { label: string; onClick?: () => void; href?: string };
  } = !asOf
    ? {
        tone: "muted",
        text: t.floors.noData,
        action: showData ? { label: t.floors.toData, href: `/o/${orgId}/b/${buildingId}/data` } : undefined,
      }
    : !fresh
      ? {
          tone: "muted",
          text: fill(t.floors.statusStale, {
            date: latestAt
              ? dateTime(latestAt, locale, tz, { dateStyle: "medium", timeStyle: "short" })
              : asOf,
          }),
          action: showData ? { label: t.floors.toData, href: `/o/${orgId}/b/${buildingId}/data` } : undefined,
        }
      : worst
        ? {
            tone: "waste",
            text: fill(t.floors.statusAction, { n: wastingNow.length }),
            action: split
              ? undefined
              : {
                  label: fill(t.floors.showFloor, { floor: worst.label }),
                  onClick: () => {
                    tick();
                    setPicked(bottomUp.findIndex((f) => f.floorId === worst.floorId));
                    hero.current?.scrollIntoView({ behavior: glide(), block: "nearest" });
                  },
                },
          }
        : {
            tone: "saving",
            text: t.floors.statusOk,
            sub: t.floors.statusOkSub,
            action:
              role === "tenant_admin"
                ? undefined
                : {
                    label: t.firstUse.step2Link,
                    onClick: () => {
                      tick();
                      assistant.current?.scrollIntoView({ behavior: glide(), block: "start" });
                    },
                  },
          };
  const StatusIcon = status.tone === "waste" ? CircleAlert : status.tone === "saving" ? CircleCheck : WifiOff;

  return (
    <>
      <PageHeader
        title={t.floors.title}
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

      <section
        aria-live="polite"
        className={clsx(
          "mb-4 rounded-2xl border p-3 sm:px-4",
          status.tone === "waste" && "border-waste/40 bg-waste-soft",
          status.tone === "saving" && "border-border bg-saving-soft",
          status.tone === "muted" && "border-border bg-surface-2",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusIcon
            className={clsx(
              "size-5 shrink-0",
              status.tone === "waste" && "text-waste",
              status.tone === "saving" && "text-saving",
              status.tone === "muted" && "text-muted",
            )}
            aria-hidden
          />
          <p className="min-w-0 flex-1 text-[15px] font-semibold tracking-tight">
            {status.text}
            {membership?.orgPlan === "demo" ? (
              <span className="ml-2 inline-block rounded-full bg-surface px-2 py-0.5 align-middle text-xs font-normal text-muted">
                {t.simulated}
              </span>
            ) : null}
          </p>
          {status.action?.href ? (
            <Link
              href={status.action.href}
              className="fc-press fc-prominent inline-flex min-h-11 items-center gap-0.5 rounded-full px-4 text-sm font-semibold sm:min-h-9"
            >
              {status.action.label} <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : status.action ? (
            <button
              type="button"
              onClick={status.action.onClick}
              className="fc-press fc-prominent inline-flex min-h-11 items-center gap-0.5 rounded-full px-4 text-sm font-semibold sm:min-h-9"
            >
              {status.action.label} <ChevronRight className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
        {/* what the page is, for whoever wants it; the status line above is what matters at a glance */}
        <details className="group mt-1 pl-8 text-xs text-muted">
          <summary className="fc-press inline-flex min-h-11 cursor-pointer list-none items-center gap-0.5 font-medium sm:min-h-0 [&::-webkit-details-marker]:hidden">
            {status.sub ? `${status.sub} ` : ""}
            {t.common.more}
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <p className="mt-1 max-w-3xl">{fill(t.floors.subtitle, { days })}</p>
        </details>
      </section>

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
            names={names}
          />
          <div className="pointer-events-none absolute top-4 left-4">
            <div className="text-xs text-muted">
              {t.floors.now}
              {o.floors[0]?.at
                ? ` · ${dateTime(o.floors[0].at, locale, tz, { dateStyle: undefined, timeStyle: "short" })}`
                : ""}
            </div>
            {/* a floor with no recent reading is a floor nobody knows about now, not an empty one */}
            {fresh ? (
              <div className="num mt-0.5 text-3xl font-semibold tracking-tight">
                {inBuilding} <span className="text-sm font-normal text-muted">{t.floors.inBuilding}</span>
              </div>
            ) : (
              <div className="mt-1 text-sm font-medium">
                {asOf ? fill(t.floors.noReadingUntil, { date: asOf }) : t.floors.noReading}
              </div>
            )}
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

      {!split && l ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {/* the money first: what the energy nobody needed cost over the window, priced at the building's tariff */}
          <Metric
            label={fill(t.floors.wastedCost, { days })}
            value={money(l.avoidableCost, locale, building!.currency)}
            tone="waste"
            sub={`${kwh(l.avoidableKwh, locale)} · ${fill(t.floors.ofUse, { share: pct(l.avoidableShare, locale, 1) })}`}
          />
          <Metric
            label={fill(t.floors.energy28, { days })}
            value={kwh(l.kwh, locale)}
            sub={money(l.cost, locale, building!.currency)}
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
