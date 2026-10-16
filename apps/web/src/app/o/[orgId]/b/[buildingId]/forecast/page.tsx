"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
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
  const fc = useQuery({
    queryKey: ["forecast", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/forecasts", {
          params: { path: { orgId, buildingId }, query: { days: 7 } },
        }),
      ),
  });
  if (fc.isPending || floors.isPending) return <Loading />;
  if (fc.error) return <ErrorBox error={fc.error} onRetry={() => fc.refetch()} />;
  const days = [...new Set(fc.data.map((r) => r.day))].sort();
  const cell = new Map(fc.data.map((r) => [`${r.floorId}|${r.day}`, r]));
  const rows = [...(floors.data ?? [])].sort((a, b) => b.level - a.level);
  const method = fc.data[0]?.method;

  return (
    <>
      <PageHeader title={t.forecast.title} subtitle={t.forecast.subtitle} />
      {fc.data.length === 0 ? (
        <Empty>{t.common.noData}</Empty>
      ) : (
        <Card pad>
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
      )}
    </>
  );
}
