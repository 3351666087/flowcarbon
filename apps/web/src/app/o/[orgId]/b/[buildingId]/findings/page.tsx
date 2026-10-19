"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BuildingBrief } from "@/components/building-brief";
import { MEASURE_TONE, strategyName } from "@/components/finding-plan";
import { FindingsTabs } from "@/components/findings-tabs";
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
import { co2, dateTime, day, kwh, money } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
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
  const sort = (params.get("sort") ?? "time") as "time" | "floor" | "kwh";
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => unwrap(api.GET("/api/v1/rules")),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const list = useInfiniteQuery({
    queryKey: ["findings", orgId, buildingId, status, floorId, ruleId, sort],
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
              sort,
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
      <FindingsTabs active="findings" />
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
        {/* the assistant's overall advice comes first on a phone, beside the list on a wide screen */}
        <div className="mb-5 lg:sticky lg:top-6 lg:order-2 lg:mb-0">
          <BuildingBrief
            onShow={(floor, rule) => {
              const next = new URLSearchParams(params);
              next.set("floorId", floor);
              next.set("ruleId", rule);
              next.delete("status");
              router.replace(`?${next}`);
            }}
          />
        </div>
        <div className="min-w-0 lg:order-1">
          {/* status as chips to swipe through, floor and rule side by side */}
          <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
            {(["open", "acknowledged", "fixed", "dismissed", "all"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={status === k}
                onClick={() => setFilter("status", k === "open" ? "" : k)}
                className={clsx(
                  "fc-press shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium",
                  status === k
                    ? "bg-text text-bg"
                    : "border border-border bg-surface text-muted hover:text-text",
                )}
              >
                {k === "all" ? t.common.all : t.findings.statuses[k]}
              </button>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-3 gap-2 lg:max-w-2xl">
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
            <Select
              aria-label={t.findings.sort}
              value={sort}
              onChange={(e) => setFilter("sort", e.target.value === "time" ? "" : e.target.value)}
            >
              {(["time", "floor", "kwh"] as const).map((k) => (
                <option key={k} value={k}>
                  {t.findings.sorts[k]}
                </option>
              ))}
            </Select>
          </div>

          {list.isPending ? (
            <Loading page />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <Empty>{t.common.noData}</Empty>
          ) : (
            <>
              {/* cards grouped by day or floor, each one opens the finding; the table only where it has room beside the AI overview */}
              <div className="space-y-5 2xl:hidden">
                {group(items, sort, tz, floorLabel).map(([key, group]) => (
                  <section key={key}>
                    {key ? (
                      <h2 className="mb-2 px-1 text-xs font-semibold text-muted">
                        {sort === "time" ? day(key, locale) : key}
                      </h2>
                    ) : null}
                    <ul className="overflow-hidden rounded-2xl border border-border bg-surface">
                      {group.map((f) => (
                        <li key={f.id} className="border-b border-border last:border-0">
                          <Link
                            href={`/o/${orgId}/b/${buildingId}/findings/${f.id}`}
                            className="fc-press flex items-center gap-3 px-3.5 py-3"
                          >
                            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-[15px] font-semibold">
                              {floorLabel.get(f.floorId) ?? "–"}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-medium">
                                {t.domain.ruleNames[f.ruleId] ?? f.ruleName}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                                {dateTime(f.startAt, locale, tz, {
                                  dateStyle: undefined,
                                  timeStyle: "short",
                                })}
                                <span aria-hidden>·</span>
                                <span className="num font-medium whitespace-nowrap text-waste">
                                  {kwh(f.avoidableKwh, locale)}
                                </span>
                                <span className="num truncate">
                                  {money(f.avoidableCost, locale, building!.currency)}
                                </span>
                              </span>
                              {f.measure && f.measure.status !== "cancelled" ? (
                                <span className="mt-1 block truncate text-xs text-accent">
                                  {fill(t.findings.inMeasure, {
                                    strategy: strategyName(t, f.measure.strategyId),
                                    status: t.plan.statuses[f.measure.status] ?? "",
                                  })}
                                </span>
                              ) : null}
                            </span>
                            <Badge tone={STATUS_TONE[f.status]}>{t.findings.statuses[f.status]}</Badge>
                            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                {list.hasNextPage ? (
                  <div className="flex justify-center">
                    <Button busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                      {t.common.next}
                    </Button>
                  </div>
                ) : null}
              </div>
              <Card pad className="hidden 2xl:block">
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
                          {money(f.avoidableCost, locale, building!.currency)} ·{" "}
                          {co2(f.avoidableCo2eKg, locale)}
                        </div>
                      </td>
                      <td>
                        <TierBadge tier={f.tier} />
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[f.status]}>{t.findings.statuses[f.status]}</Badge>
                        {f.measure && f.measure.status !== "cancelled" ? (
                          <div className="mt-1">
                            <Badge tone={MEASURE_TONE[f.measure.status]}>
                              {strategyName(t, f.measure.strategyId)}
                            </Badge>
                          </div>
                        ) : null}
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
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Phone cards come in groups that follow the order: by day, by floor, or one list for the largest first. */
function group<T extends { startAt: string; floorId: string }>(
  items: T[],
  sort: "time" | "floor" | "kwh",
  tz: string,
  floorLabel: Map<string, string>,
): [string, T[]][] {
  if (sort === "kwh") return [["", items]];
  if (sort === "time") return groupByDay(items, tz);
  const groups = new Map<string, T[]>();
  for (const f of items) {
    const key = floorLabel.get(f.floorId) ?? "–";
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  return [...groups];
}

/** Findings in order, grouped under the building-local day they started. */
function groupByDay<T extends { startAt: string }>(items: T[], tz: string): [string, T[]][] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const groups = new Map<string, T[]>();
  for (const f of items) {
    const d = fmt.format(new Date(f.startAt));
    const g = groups.get(d);
    if (g) g.push(f);
    else groups.set(d, [f]);
  }
  return [...groups];
}

export default function FindingsPage() {
  return (
    <Suspense fallback={<Loading page />}>
      <Findings />
    </Suspense>
  );
}
