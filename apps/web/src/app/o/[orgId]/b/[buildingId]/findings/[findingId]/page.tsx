"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { IntervalChart } from "@/components/charts";
import { Badge, Button, Card, ErrorBox, Input, Loading, Metric, TierBadge } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { co2, dateTime, kwh, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { can, useBuilding, useFloors, useIds, useMembership } from "@/lib/session";

interface ExplanationOutput {
  whatHappened: string;
  likelyCauses: string[];
  outlook: string;
  recommendedAction: { strategyId: string; reason: string };
  basis: { id: string; title: string }[];
  uncertainties: string[];
}

export default function FindingPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { findingId } = useParams<{ findingId: string }>();
  const { building } = useBuilding();
  const floors = useFloors();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const path = { orgId, buildingId, findingId };

  const finding = useQuery({
    queryKey: ["finding", findingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}", { params: { path } }),
      ),
    // poll while an explanation is being written
    refetchInterval: (q) => (q.state.data?.explanations[0]?.status === "pending" ? 3000 : false),
  });
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => unwrap(api.GET("/api/v1/rules")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const f = finding.data;
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

  const review = useMutation({
    mutationFn: (status: "open" | "acknowledged" | "fixed" | "dismissed") =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}", {
          params: { path },
          body: { status, note: note || undefined },
        }),
      ),
    onSuccess: (data) => {
      qc.setQueryData(["finding", findingId], (old: typeof f) => (old ? { ...old, ...data } : old));
      qc.invalidateQueries({ queryKey: ["findings"] });
      setNote("");
    },
  });
  const explain = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}/explanations", {
          params: { path },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finding", findingId] }),
  });

  if (finding.isPending) return <Loading />;
  if (finding.error || !f) return <ErrorBox error={finding.error} onRetry={() => finding.refetch()} />;
  const floor = floors.data?.find((x) => x.id === f.floorId);
  const rule = rules.data?.rules.find((r) => r.id === f.ruleId);
  const strategies = new Map((rules.data?.strategies ?? []).map((s) => [s.id, s.name]));
  const latest = f.explanations[0];
  const out = latest?.status === "done" ? (latest.output as unknown as ExplanationOutput) : null;

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
              {floor?.label} · {t.domain.ruleNames[f.ruleId] ?? f.ruleName}
            </h1>
            <Badge tone={f.kind === "waste" ? "waste" : "accent"}>{t.findings.kinds[f.kind]}</Badge>
            <TierBadge tier={f.tier} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {dateTime(f.startAt, locale, tz)} –{" "}
            {dateTime(f.endAt, locale, tz, { dateStyle: undefined, timeStyle: "short" })}
          </p>
        </div>
        <Badge tone={f.status === "open" ? "waste" : f.status === "fixed" ? "saving" : "neutral"}>
          {t.findings.statuses[f.status]}
        </Badge>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t.findings.avoidable} value={kwh(f.avoidableKwh, locale)} tone="waste" />
        <Metric label={t.report.cost} value={money(f.avoidableCost, locale, building!.currency)} />
        <Metric label="CO₂e" value={co2(f.avoidableCo2eKg, locale)} />
        <Metric label={t.findings.peak} value={f.peakPeople} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
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
          <Card title={t.findings.params}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {Object.entries(f.params).length === 0 ? (
                <p className="text-muted">{t.findings.defaults}</p>
              ) : null}
              {Object.entries(f.params).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-border py-1">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num font-medium">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        <div className="space-y-6">
          {can.reviewFindings(role) ? (
            <Card title={t.findings.review}>
              <Input
                placeholder={f.status === "open" ? t.findings.dismissReason : t.common.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {f.status !== "acknowledged" ? (
                  <Button onClick={() => review.mutate("acknowledged")} busy={review.isPending}>
                    {t.findings.acknowledge}
                  </Button>
                ) : null}
                {f.status !== "fixed" ? (
                  <Button onClick={() => review.mutate("fixed")} busy={review.isPending}>
                    {t.findings.markFixed}
                  </Button>
                ) : null}
                {f.status !== "dismissed" ? (
                  <Button
                    variant="danger"
                    disabled={!note.trim()}
                    onClick={() => review.mutate("dismissed")}
                    busy={review.isPending}
                  >
                    {t.findings.dismiss}
                  </Button>
                ) : null}
                {f.status !== "open" ? (
                  <Button variant="ghost" onClick={() => review.mutate("open")}>
                    {t.findings.reopen}
                  </Button>
                ) : null}
              </div>
              {f.statusNote ? <p className="mt-3 text-xs text-muted">“{f.statusNote}”</p> : null}
              {review.error ? (
                <div className="mt-3">
                  <ErrorBox error={review.error} />
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card
            title={
              <span className="inline-flex items-center gap-2">
                <Sparkles className="size-4 text-accent" aria-hidden /> {t.findings.ai}
              </span>
            }
          >
            <p className="text-xs text-muted">{t.findings.aiHint}</p>
            {latest?.status === "pending" ? <p className="mt-3 text-sm">{t.findings.aiPending}</p> : null}
            {latest?.status === "failed" ? (
              <p className="mt-3 text-sm text-danger">
                {t.findings.aiFailed}: {latest.error}
              </p>
            ) : null}
            {out ? (
              <div className="mt-3 space-y-3 text-sm">
                <section>
                  <h3 className="text-xs font-semibold text-muted">{t.findings.aiWhat}</h3>
                  <p>{out.whatHappened}</p>
                </section>
                <section>
                  <h3 className="text-xs font-semibold text-muted">{t.findings.aiCauses}</h3>
                  <ul className="list-disc pl-5">
                    {out.likelyCauses.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="text-xs font-semibold text-muted">{t.findings.aiOutlook}</h3>
                  <p>{out.outlook}</p>
                </section>
                <section className="rounded-lg bg-accent-soft p-3">
                  <h3 className="text-xs font-semibold text-accent">{t.findings.aiAction}</h3>
                  <p className="font-medium">
                    {t.domain.strategies[out.recommendedAction.strategyId]?.name ?? strategies.get(out.recommendedAction.strategyId) ?? out.recommendedAction.strategyId}
                  </p>
                  <p>{out.recommendedAction.reason}</p>
                </section>
                <section>
                  <h3 className="text-xs font-semibold text-muted">{t.findings.aiBasis}</h3>
                  <ul className="list-disc pl-5 text-xs">
                    {out.basis.map((b) => (
                      <li key={b.id}>{b.title}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="text-xs font-semibold text-muted">{t.findings.aiUncertain}</h3>
                  <ul className="list-disc pl-5 text-xs text-muted">
                    {out.uncertainties.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </section>
                <p className="text-[11px] text-muted">
                  {latest?.model} · {latest?.promptVersion} ·{" "}
                  {dateTime(latest?.completedAt ?? null, locale, tz)}
                </p>
              </div>
            ) : null}
            {can.explain(role) && latest?.status !== "pending" ? (
              <Button
                className="mt-4"
                variant={out ? "secondary" : "primary"}
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
        </div>
      </div>
    </>
  );
}
