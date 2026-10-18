"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Hammer } from "lucide-react";
import Link from "next/link";
import { MEASURE_TONE, strategyName, verdictLine } from "@/components/finding-plan";
import { FindingsTabs } from "@/components/findings-tabs";
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { dateTime, kwh, money } from "@/lib/format";
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
                      totals.planned
                        ? fill(t.measures.planned, {
                            n: totals.planned,
                            kwh: kwh(totals.expectedWeeklyKwh, locale),
                            cost: money(totals.expectedWeeklyCost, locale, currency),
                          })
                        : null,
                      totals.inEffect > totals.measured
                        ? fill(t.measures.waiting, { n: totals.inEffect - totals.measured })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                </Card>
              ) : null}
            </div>
          ) : null}
          <ul className="overflow-hidden rounded-2xl border border-border bg-surface">
            {items.map((m) => {
              const v = verdictLine(t, m.verification, locale, currency);
              return (
                <li key={m.id} className="border-b border-border last:border-0">
                  <Link
                    href={`/o/${orgId}/b/${buildingId}/measures/${m.id}`}
                    className="fc-press flex items-start gap-3 px-3.5 py-3.5"
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-[15px] font-semibold">
                      {m.floorLabel}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <Hammer className="size-3.5 shrink-0 text-accent" aria-hidden />
                        <span className="truncate text-[15px] font-medium">
                          {strategyName(t, m.strategyId)}
                        </span>
                      </span>
                      <span
                        className={clsx(
                          "mt-1 line-clamp-2 block text-xs",
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
                          : fill(t.plan.covers, { n: m.findings.total, floor: m.floorLabel })}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={MEASURE_TONE[m.status]}>{t.plan.statuses[m.status]}</Badge>
                      <span className="num text-xs font-medium">
                        {m.verification.after?.days ? "" : `${t.measures.expected} `}
                        {kwh(m.verification.weekly.kwh, locale)}
                        <span className="text-muted"> / {t.measures.week}</span>
                      </span>
                    </span>
                    <ChevronRight className="mt-3 size-4 shrink-0 text-muted" aria-hidden />
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
