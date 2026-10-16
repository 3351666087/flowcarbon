"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Badge, Card, ErrorBox, Loading, Metric, PageHeader, Table } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { dateTime, num } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useBuilding, useFloors, useIds } from "@/lib/session";

export default function DataPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const floors = useFloors();
  const path = { orgId, buildingId };
  const tz = building!.timezone;
  const health = useQuery({
    queryKey: ["health", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/data-health", { params: { path } })),
    refetchInterval: 30_000,
  });
  const devices = useQuery({
    queryKey: ["devices", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/devices", { params: { path } })),
  });
  const batches = useQuery({
    queryKey: ["batches", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/ingestion-batches", {
          params: { path, query: { limit: 25 } },
        }),
      ),
    refetchInterval: 15_000,
  });
  if (health.isPending) return <Loading />;
  if (health.error) return <ErrorBox error={health.error} onRetry={() => health.refetch()} />;
  const h = health.data;
  const floorLabel = new Map((floors.data ?? []).map((f) => [f.id, f.label]));

  return (
    <>
      <PageHeader title={t.data.title} subtitle={t.data.subtitle} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t.data.devices} value={h.devices} />
        <Metric
          label={t.data.silent}
          value={h.silentDevices.length}
          tone={h.silentDevices.length ? "waste" : "saving"}
        />
        <Metric label={t.data.pending} value={h.pendingBatches} />
        <Metric
          label={t.data.failed}
          value={h.failedBatches}
          tone={h.failedBatches ? "waste" : undefined}
          sub={h.lastReceivedAt ? `${t.data.received} ${dateTime(h.lastReceivedAt, locale, tz)}` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title={t.data.devices}>
          {devices.isPending ? (
            <Loading />
          ) : (
            <Table head={[t.data.external, t.data.kind, t.common.floor, t.data.lastSeen]}>
              {(devices.data ?? []).map((d) => {
                const silent = h.silentDevices.some((s) => s.id === d.id);
                return (
                  <tr key={d.id}>
                    <td className="font-mono text-xs">{d.externalId}</td>
                    <td className="text-xs">
                      {d.kind}
                      {d.system ? ` · ${d.system}` : ""}
                    </td>
                    <td>{d.floorId ? floorLabel.get(d.floorId) : "–"}</td>
                    <td className="whitespace-nowrap text-xs">
                      {silent ? (
                        <Badge tone="waste">{dateTime(d.lastSeenAt, locale, tz)}</Badge>
                      ) : (
                        dateTime(d.lastSeenAt, locale, tz)
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          {h.silentDevices.length === 0 ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-saving">
              <CheckCircle2 className="size-4" aria-hidden /> {t.data.healthy}
            </p>
          ) : null}
        </Card>
        <Card title={t.data.batches}>
          {batches.isPending ? (
            <Loading />
          ) : (
            <Table head={[t.data.received, t.data.items, t.common.status]}>
              {(batches.data ?? []).map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap text-xs">
                    {dateTime(b.receivedAt, locale, tz)}
                    <div className="font-mono text-[11px] text-muted">{b.idempotencyKey}</div>
                  </td>
                  <td className="num text-xs">
                    {num(
                      Object.values(b.counts).reduce((s, v) => s + v, 0),
                      locale,
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={b.status === "processed" ? "saving" : b.status === "failed" ? "danger" : "waste"}
                    >
                      {b.status === "processed"
                        ? t.data.processed
                        : b.status === "failed"
                          ? t.data.failed
                          : t.data.pending}
                    </Badge>
                    {b.error ? <div className="mt-1 text-[11px] text-danger">{b.error}</div> : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
