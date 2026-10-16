"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  Select,
  Table,
  TierBadge,
} from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { co2, dateTime, kwh, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useBuilding, useFloors, useIds } from "@/lib/session";

const STATUS_TONE = { open: "waste", acknowledged: "accent", fixed: "saving", dismissed: "neutral" } as const;

function Findings() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const floors = useFloors();
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get("status") ?? "open";
  const floorId = params.get("floorId") ?? "";
  const ruleId = params.get("ruleId") ?? "";
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => unwrap(api.GET("/api/v1/rules")),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const list = useInfiniteQuery({
    queryKey: ["findings", orgId, buildingId, status, floorId, ruleId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings", {
          params: {
            path: { orgId, buildingId },
            query: {
              limit: 50,
              cursor: pageParam,
              status: status === "all" ? undefined : (status as "open"),
              floorId: floorId || undefined,
              ruleId: ruleId || undefined,
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`?${next}`);
  };
  const floorLabel = new Map((floors.data ?? []).map((f) => [f.id, f.label]));
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const tz = building!.timezone;

  return (
    <>
      <PageHeader title={t.findings.title} subtitle={t.findings.subtitle} />
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:max-w-3xl">
        <Select
          aria-label={t.common.status}
          value={status}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          <option value="all">{t.common.all}</option>
          {Object.entries(t.findings.statuses).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t.common.floor}
          value={floorId}
          onChange={(e) => setFilter("floorId", e.target.value)}
        >
          <option value="">
            {t.common.floor}: {t.common.all}
          </option>
          {(floors.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t.findings.rule}
          value={ruleId}
          onChange={(e) => setFilter("ruleId", e.target.value)}
        >
          <option value="">
            {t.findings.rule}: {t.common.all}
          </option>
          {(rules.data?.rules ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {t.domain.ruleNames[r.id] ?? r.name}
            </option>
          ))}
        </Select>
      </div>

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{t.common.noData}</Empty>
      ) : (
        <Card pad>
          <Table
            head={[
              t.findings.when,
              t.common.floor,
              t.findings.rule,
              t.findings.avoidable,
              "",
              t.common.status,
            ]}
          >
            {items.map((f) => (
              <tr key={f.id} className="hover:bg-surface-2">
                <td className="whitespace-nowrap">
                  <Link
                    className="font-medium hover:underline"
                    href={`/o/${orgId}/b/${buildingId}/findings/${f.id}`}
                  >
                    {dateTime(f.startAt, locale, tz)}
                  </Link>
                </td>
                <td className="font-medium">{floorLabel.get(f.floorId) ?? "–"}</td>
                <td>
                  <div>{t.domain.ruleNames[f.ruleId] ?? f.ruleName}</div>
                  <div className="text-xs text-muted">{t.findings.kinds[f.kind]}</div>
                </td>
                <td className="num whitespace-nowrap">
                  <div className="font-medium text-waste">{kwh(f.avoidableKwh, locale)}</div>
                  <div className="text-xs text-muted">
                    {money(f.avoidableCost, locale, building!.currency)} · {co2(f.avoidableCo2eKg, locale)}
                  </div>
                </td>
                <td>
                  <TierBadge tier={f.tier} />
                </td>
                <td>
                  <Badge tone={STATUS_TONE[f.status]}>{t.findings.statuses[f.status]}</Badge>
                </td>
              </tr>
            ))}
          </Table>
          {list.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                {t.common.next}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}

export default function FindingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Findings />
    </Suspense>
  );
}
