"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback } from "react";
import { AiExplanation, type Explanation } from "@/components/ai-explanation";
import { useAuthMethods } from "@/components/auth-code";
import { IntervalChart } from "@/components/charts";
import { HistoryCard, ThresholdSheet, ThresholdsCard } from "@/components/finding-extras";
import {
  AiActions,
  DismissSheet,
  MEASURE_TONE,
  strategyName as nameOf,
  PlanCard,
  PlanSheet,
  type Recommendation,
  usePlan,
} from "@/components/finding-plan";
import { Badge, Button, Card, ErrorBox, Loading, Metric, TierBadge } from "@/components/ui";
import { ApiError, api, unwrap } from "@/lib/api";
import type { FindingDetail } from "@/lib/api-shapes";
import { co2, dateTime, kwh, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { can, useBuilding, useFloors, useIds, useMembership } from "@/lib/session";

const STATUS_TONE = { open: "waste", acknowledged: "accent", fixed: "saving", dismissed: "neutral" } as const;

export default function FindingPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { findingId } = useParams<{ findingId: string }>();
  const { building } = useBuilding();
  const floors = useFloors();
  const membership = useMembership();
  const role = membership?.role;
  const methods = useAuthMethods();
  const qc = useQueryClient();
  const path = { orgId, buildingId, findingId };

  const finding = useQuery({
    queryKey: ["finding", findingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}", { params: { path } }),
      ),
    // a finding that is gone stays gone
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => unwrap(api.GET("/api/v1/rules")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const f = finding.data as FindingDetail | undefined;
  const tz = building!.timezone;
  const localDate = f
    ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(f.startAt))
    : undefined;
  const intervals = useQuery({
    queryKey: ["intervals", f?.floorId, localDate],
    enabled: !!f,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/floors/{floorId}/intervals", {
          params: { path: { orgId, buildingId, floorId: f!.floorId }, query: { date: localDate! } },
        }),
      ),
  });

  const explain = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}/explanations", {
          params: { path },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finding", findingId], exact: true }),
  });
  const strategyNames = rules.data?.strategies;
  const strategyName = useCallback(
    (id: string) => t.domain.strategies[id]?.name ?? strategyNames?.find((s) => s.id === id)?.name,
    [t, strategyNames],
  );

  const latest = f?.explanations[0] as Explanation | undefined;
  const done = latest?.status === "done" ? (latest.output as { recommendedAction?: Recommendation }) : null;
  const rec: Recommendation | null =
    done?.recommendedAction && latest
      ? {
          strategyId: done.recommendedAction.strategyId,
          reason: done.recommendedAction.reason,
          explanationId: latest.id,
        }
      : null;
  const floorLabel = floors.data?.find((x) => x.id === f?.floorId)?.label ?? "";
  const ctx = f ? { f, path, floorLabel, currency: building!.currency, timeZone: tz } : null;
  const plan = usePlan(
    ctx ??
      ({ f: {} as FindingDetail, path, floorLabel, currency: building!.currency, timeZone: tz } as never),
    rec,
  );

  if (finding.isPending) return <Loading page />;
  // reprocessing (new thresholds, late data) can take away an open finding someone is looking at
  if (finding.error instanceof ApiError && finding.error.status === 404)
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">{t.findings.gone}</h1>
        <p className="mt-2 text-sm text-muted">{t.findings.goneSub}</p>
        <Link
          href={`/o/${orgId}/b/${buildingId}/findings`}
          className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-accent"
        >
          <ArrowLeft className="size-4" aria-hidden /> {t.findings.back}
        </Link>
      </div>
    );
  if (finding.error || !f || !ctx)
    return <ErrorBox error={finding.error} onRetry={() => finding.refetch()} />;
  const rule = rules.data?.rules.find((r) => r.id === f.ruleId);
  const reviewer = can.reviewFindings(role);
  const active = f.measureDetail && f.measureDetail.status !== "cancelled" ? f.measureDetail : null;
  const deciding = f.status === "open" && !active;
  const sharedDemo = !!methods.data?.demo && membership?.orgSlug === methods.data.demo.slug;

  const planCard = (
    <Card title={t.plan.title}>
      <PlanCard ctx={ctx} plan={plan} rec={rec} role={role} sharedDemo={sharedDemo} />
    </Card>
  );
  const aiCard = (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden /> {t.findings.ai}
        </span>
      }
    >
      <p className="text-xs text-muted">{t.findings.aiHint}</p>
      <AiExplanation
        key={latest?.id}
        path={path}
        latest={latest}
        strategyName={strategyName}
        timeZone={tz}
        actions={reviewer && deciding && rec ? <AiActions plan={plan} rec={rec} /> : null}
      />
      {can.explain(role) && latest?.status !== "pending" ? (
        <Button
          className="mt-4"
          variant={latest?.status === "done" ? "secondary" : "primary"}
          busy={explain.isPending}
          onClick={() => explain.mutate()}
        >
          <Sparkles className="size-4" aria-hidden /> {t.findings.aiRequest}
        </Button>
      ) : null}
      {explain.error ? (
        <div className="mt-3">
          <ErrorBox error={explain.error} />
        </div>
      ) : null}
    </Card>
  );

  return (
    <>
      <Link
        href={`/o/${orgId}/b/${buildingId}/findings`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t.findings.back}
      </Link>
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold sm:text-2xl">
              {floorLabel} · {t.domain.ruleNames[f.ruleId] ?? f.ruleName}
            </h1>
            <Badge tone={f.kind === "waste" ? "waste" : "accent"}>{t.findings.kinds[f.kind]}</Badge>
            <TierBadge tier={f.tier} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {dateTime(f.startAt, locale, tz)} –{" "}
            {dateTime(f.endAt, locale, tz, { dateStyle: undefined, timeStyle: "short" })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={STATUS_TONE[f.status]}>{t.findings.statuses[f.status]}</Badge>
          {active ? (
            <Badge tone={MEASURE_TONE[active.status]}>
              {nameOf(t, active.strategyId)} · {t.plan.statuses[active.status]}
            </Badge>
          ) : null}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t.findings.avoidable} value={kwh(f.avoidableKwh, locale)} tone="waste" />
        <Metric label={t.report.cost} value={money(f.avoidableCost, locale, building!.currency)} />
        <Metric label="CO₂e" value={co2(f.avoidableCo2eKg, locale)} />
        <Metric label={t.findings.peak} value={f.peakPeople} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* on a phone the decision comes first: while it is open, the assistant's reasons and its suggestion */}
        <div className="space-y-6 lg:col-start-2 lg:row-start-1">
          <div className={clsx("flex flex-col gap-6", deciding && "flex-col-reverse")}>
            {planCard}
            {aiCard}
          </div>
          {f.activity.length ? (
            <Card title={t.plan.history}>
              <HistoryCard f={f} timeZone={tz} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-6 lg:col-start-1 lg:row-start-1">
          <Card title={t.findings.evidence}>
            <p className="text-sm">{t.domain.summary?.(f.ruleId, f.evidence.facts) ?? f.evidence.summary}</p>
            {rule && locale === "en" ? <p className="mt-2 text-xs text-muted">{rule.physics}</p> : null}
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {Object.entries(f.evidence.facts).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-border py-1">
                  <dt className="text-muted">{t.domain.factLabels[k] ?? k}</dt>
                  <dd className="num text-right font-medium">
                    {k === "dataTier"
                      ? v === "measured"
                        ? t.common.measured
                        : t.common.estimated
                      : String(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title={t.findings.dayChart}>
            {intervals.isPending ? (
              <Loading />
            ) : intervals.data ? (
              <IntervalChart
                locale={locale}
                timeZone={tz}
                highlight={{ from: f.startAt, to: f.endAt }}
                data={intervals.data.map((i) => ({
                  start: i.start,
                  occupancy: i.occupancy,
                  hvacOn: i.hvacOn,
                  kwh: i.kwhHvac + i.kwhLighting + i.kwhPlug,
                }))}
                labels={{
                  people: t.findings.occupancy,
                  hvac: t.findings.hvacOn,
                  kwh: t.findings.energy,
                  flagged: t.findings.avoidable,
                }}
              />
            ) : null}
          </Card>
          {f.thresholds.length ? (
            <Card title={t.findings.params}>
              <ThresholdsCard
                f={f}
                canEdit={can.editBuilding(role)}
                onAdjust={(key) => plan.open({ kind: "threshold", key })}
              />
            </Card>
          ) : null}
        </div>
      </div>

      {plan.sheet?.kind === "plan" ? (
        <PlanSheet ctx={ctx} plan={plan} rec={rec} mode={plan.sheet.mode} onClose={() => plan.open(null)} />
      ) : null}
      {plan.sheet?.kind === "dismiss" ? (
        <DismissSheet
          plan={plan}
          onClose={() => plan.open(null)}
          onAdjust={
            can.editBuilding(role) && f.thresholds[0]
              ? () => plan.open({ kind: "threshold", key: f.thresholds[0]!.key })
              : undefined
          }
        />
      ) : null}
      {plan.sheet?.kind === "threshold" ? (
        <ThresholdSheet
          f={f}
          thresholdKey={plan.sheet.key}
          building={{ timezone: tz, ruleParams: (building!.ruleParams ?? {}) as Record<string, unknown> }}
          path={{ orgId, buildingId }}
          onClose={() => plan.open(null)}
        />
      ) : null}
    </>
  );
}
