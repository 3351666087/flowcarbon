"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useState } from "react";
import { tick } from "@/components/glass";
import { Card, Empty, ErrorBox, Loading, PageHeader } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { day } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useFloors, useIds } from "@/lib/session";

const TONE: Record<string, string> = {
  on_demand: "bg-accent-soft text-accent",
  setback: "bg-waste-soft text-waste",
  off: "bg-surface-2 text-muted",
};

export default function ForecastPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const floors = useFloors();
  const [picked, setPicked] = useState<string | null>(null);
  const fc = useQuery({
    queryKey: ["forecast", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/forecasts", {
          params: { path: { orgId, buildingId }, query: { days: 7 } },
        }),
      ),
  });
  if (fc.isPending || floors.isPending) return <Loading page />;
  if (fc.error) return <ErrorBox error={fc.error} onRetry={() => fc.refetch()} />;
  const days = [...new Set(fc.data.map((r) => r.day))].sort();
  const cell = new Map(fc.data.map((r) => [`${r.floorId}|${r.day}`, r]));
  const rows = [...(floors.data ?? [])].sort((a, b) => b.level - a.level);
  const method = fc.data[0]?.method;
  const selected = picked && days.includes(picked) ? picked : days[0];
  const today = rows.map((f) => ({ f, c: cell.get(`${f.id}|${selected}`) }));
  const peak = Math.max(1, ...today.map(({ c }) => c?.high ?? 0));
  const people = today.reduce((n, { c }) => n + (c?.median ?? 0), 0);
  const cooled = today.filter(({ c }) => c && c.advice !== "off").length;

  return (
    <>
      <PageHeader title={t.forecast.title} subtitle={t.forecast.subtitle} />
      {fc.data.length === 0 ? (
        <Empty>{t.common.noData}</Empty>
      ) : (
        <>
          {/* phones: a strip of days, then the floors for the chosen day */}
          <div className="md:hidden">
            <div className="-mx-4 mb-4 grid grid-flow-col auto-cols-[minmax(3.4rem,1fr)] gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
              {days.map((d) => {
                const on = d === selected;
                const type = cell.get(`${rows[0]?.id}|${d}`)?.dayType ?? "workday";
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      if (!on) tick();
                      setPicked(d);
                    }}
                    className={clsx(
                      "fc-press flex flex-col items-center rounded-2xl px-1 py-2",
                      on ? "bg-text text-bg" : "border border-border bg-surface",
                    )}
                  >
                    <span className={clsx("text-[11px]", on ? "opacity-80" : "text-muted")}>
                      {day(d, locale, { weekday: "short" })}
                    </span>
                    <span className="num text-lg leading-tight font-semibold">
                      {day(d, locale, { day: "numeric" })}
                    </span>
                    <span
                      className={clsx(
                        "mt-0.5 size-1.5 rounded-full",
                        type === "workday" ? "bg-accent" : "bg-waste",
                        on && "bg-current",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            <div className="mb-3 flex items-baseline justify-between px-1">
              <h2 className="text-sm font-semibold">
                {day(selected!, locale, { month: "long", day: "numeric", weekday: "long" })}
              </h2>
              <span className="num text-xs text-muted">
                {people} {t.common.people} · {cooled}/{rows.length}
              </span>
            </div>
            <ul className="overflow-hidden rounded-2xl border border-border bg-surface">
              {today.map(({ f, c }) => (
                <li
                  key={f.id}
                  className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-0"
                >
                  <span className="w-9 shrink-0 text-[15px] font-semibold">{f.label}</span>
                  <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                    {c ? (
                      <>
                        {/* the likely range, and the median inside it */}
                        <span
                          className="absolute inset-y-0 rounded-full bg-accent/25"
                          style={{
                            left: `${(c.low / peak) * 100}%`,
                            width: `${((c.high - c.low) / peak) * 100}%`,
                          }}
                        />
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-accent"
                          style={{ width: `${(c.median / peak) * 100}%` }}
                        />
                      </>
                    ) : null}
                  </span>
                  <span className="num w-7 shrink-0 text-right text-sm font-semibold">
                    {c ? c.median : "–"}
                  </span>
                  <span
                    className={clsx(
                      "w-[4.6rem] shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium",
                      c ? TONE[c.advice] : "bg-surface-2 text-muted",
                    )}
                  >
                    {c ? t.forecast.advice[c.advice] : "–"}
                  </span>
                </li>
              ))}
            </ul>
            {method ? <p className="mt-3 px-1 text-xs text-muted">{method}</p> : null}
          </div>
          <Card pad className="hidden md:block">
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full min-w-[720px] border-separate border-spacing-1 px-3 text-sm">
                <thead>
                  <tr className="text-xs text-muted">
                    <th className="w-16 text-left font-medium">{t.common.floor}</th>
                    {days.map((d) => (
                      <th key={d} className="font-medium">
                        {day(d, locale)}
                        <div className="font-normal">
                          {t.report.dayTypes[cell.get(`${rows[0]?.id}|${d}`)?.dayType ?? "workday"]}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id}>
                      <td className="font-semibold">{f.label}</td>
                      {days.map((d) => {
                        const c = cell.get(`${f.id}|${d}`);
                        return (
                          <td
                            key={d}
                            className={clsx(
                              "rounded-lg px-2 py-1.5 text-center",
                              c ? TONE[c.advice] : "bg-surface-2",
                            )}
                            title={
                              c
                                ? `${t.forecast.range} ${c.low}–${c.high} · ${c.basis} ${t.forecast.basis}`
                                : undefined
                            }
                          >
                            {c ? (
                              <>
                                <div className="num font-semibold">{c.median}</div>
                                <div className="text-[11px]">{t.forecast.advice[c.advice]}</div>
                              </>
                            ) : (
                              "–"
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
              {Object.entries(t.forecast.advice).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <span className={clsx("inline-block size-3 rounded", TONE[k])} /> {v}
                </span>
              ))}
              {method ? <span className="ml-auto">{method}</span> : null}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
