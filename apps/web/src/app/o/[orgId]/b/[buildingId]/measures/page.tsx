"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Hammer } from "lucide-react";
import Link from "next/link";
import { MEASURE_TONE, strategyName, verdictLine } from "@/components/finding-plan";
import { FindingsTabs } from "@/components/findings-tabs";
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { dateTime, kwh, money, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { useBuilding, useIds } from "@/lib/session";

export default function MeasuresPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const currency = building!.currency;
  const list = useQuery({
    queryKey: ["measures", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures", {
          params: { path: { orgId, buildingId } },
        }),
      ),
  });

  const items = (list.data?.items ?? []).filter((m) => m.status !== "cancelled");
  const totals = list.data?.totals;
  const assumed = items.find((m) => m.verification.expected)?.verification.expected?.realisation;
  return (
    <>
      <PageHeader title={t.measures.title} subtitle={t.measures.subtitle} />
      <FindingsTabs active="measures" />
      {list.isPending ? (
        <Loading page />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{t.measures.empty}</Empty>
      ) : (
        <>
          {totals && (totals.inEffect || totals.planned) ? (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              {totals.measured ? (
                <Card>
                  <p className="text-xs text-muted">
                    {t.measures.measured} · {t.measures.week}
                  </p>
                  <p className="num mt-1 text-2xl font-semibold text-saving">
                    {kwh(totals.weeklyKwh, locale)}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {fill(t.measures.inEffect, {
                      n: totals.measured,
                      kwh: kwh(totals.weeklyKwh, locale),
                      cost: money(totals.weeklyCost, locale, currency),
                    })}
                  </p>
                </Card>
              ) : null}
              {totals.expectedWeeklyKwh || totals.planned || totals.inEffect > totals.measured ? (
                <Card>
                  <p className="text-xs text-muted">
                    {t.measures.expected} · {t.measures.week}
                  </p>
                  <p className="num mt-1 text-2xl font-semibold">{kwh(totals.expectedWeeklyKwh, locale)}</p>
                  <p className="mt-1 text-sm text-muted">
                    {[
                      totals.planned ? fill(t.measures.planned, { n: totals.planned }) : null,
                      totals.inEffect > totals.measured
                        ? fill(t.measures.waiting, { n: totals.inEffect - totals.measured })
                        : null,
                      // an on-site check saves nothing by itself, so there is no saving to give a range for
                      totals.expectedWeeklyKwh > 0
                        ? fill(t.measures.expectedSaving, {
                            kwh: kwh(totals.expectedWeeklyKwh, locale),
                            cost: money(totals.expectedWeeklyCost, locale, currency),
                          })
                        : null,
                      totals.expectedWeeklyKwh > 0
                        ? fill(t.measures.expectedRange, {
                            low: kwh(totals.expectedWeeklyLowKwh, locale),
                            high: kwh(totals.expectedWeeklyHighKwh, locale),
                            days: totals.expectedDays,
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                  {assumed && totals.expectedWeeklyKwh > 0 ? (
                    <p className="mt-1 text-xs text-muted">
                      {fill(t.assistant.assumes, {
                        mid: pct(assumed.mid, locale),
                        low: pct(assumed.low, locale),
                        high: pct(assumed.high, locale),
                      })}
                    </p>
                  ) : null}
                </Card>
              ) : null}
            </div>
          ) : null}
          <ul className="overflow-hidden rounded-2xl border border-border bg-surface">
            {items.map((m) => {
              const v = verdictLine(t, m, locale, currency);
              return (
                <li key={m.id} className="border-b border-border last:border-0">
                  <Link
                    href={`/o/${orgId}/b/${buildingId}/measures/${m.id}`}
                    className="fc-press grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-3.5 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-[15px] font-semibold">
                      {m.floorLabel}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-start gap-2">
                        <Hammer className="mt-1 size-3.5 shrink-0 text-accent" aria-hidden />
                        <span className="min-w-0 text-[15px] font-medium">
                          {strategyName(t, m.strategyId)}
                        </span>
                      </span>
                      <span
                        className={clsx(
                          "mt-1 line-clamp-3 block text-xs sm:line-clamp-2",
                          v.tone === "saving"
                            ? "text-saving"
                            : v.tone === "waste"
                              ? "text-waste"
                              : "text-muted",
                        )}
                      >
                        {v.text}
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        {m.implementedAt
                          ? fill(t.plan.inEffectSince, {
                              date: dateTime(m.implementedAt, locale, building!.timezone, {
                                timeStyle: undefined,
                              }),
                            })
                          : fill(m.findings.total === 1 ? t.plan.coversOne : t.plan.covers, {
                              n: m.findings.total,
                              floor: m.floorLabel,
                            })}
                      </span>
                    </span>
                    {/* on a phone under the text, which then has the width of the row */}
                    <span className="col-span-2 col-start-2 row-start-2 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:mt-0 sm:flex-col sm:items-end">
                      <Badge tone={MEASURE_TONE[m.status]}>{t.plan.statuses[m.status]}</Badge>
                      <span className="num text-xs font-medium">
                        {m.verification.after?.days ? "" : `${t.measures.expected} `}
                        {kwh(m.verification.weekly.kwh, locale)}
                        <span className="text-muted"> / {t.measures.week}</span>
                        {m.verification.expected &&
                        m.verification.weekly.kwh > 0 &&
                        m.verification.verdict === "waiting" ? (
                          <span className="block font-normal text-muted sm:text-right">
                            {kwh(m.verification.expected.lowKwh, locale)} –{" "}
                            {kwh(m.verification.expected.highKwh, locale)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRight
                      className="col-start-3 row-start-1 mt-3 size-4 shrink-0 text-muted sm:col-start-4"
                      aria-hidden
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
