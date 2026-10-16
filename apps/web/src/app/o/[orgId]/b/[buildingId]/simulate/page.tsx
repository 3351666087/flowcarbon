"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CashflowChart } from "@/components/charts";
import { Button, Card, ErrorBox, Field, Input, Loading, Metric, PageHeader, Select } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { kwh, money, num, pct } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { can, useBuilding, useIds, useMembership } from "@/lib/session";

type StrategyId = "occupancy_gated_workday" | "zone_only_non_working" | "auto_lights_off" | "full_package";

export default function SimulatePage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const cur = building!.currency;
  const [strategyId, setStrategyId] = useState<StrategyId>("full_package");
  const [escoShare, setEscoShare] = useState(0.6);
  const [years, setYears] = useState(5);
  const [achieved, setAchieved] = useState(1);
  const [discountRate, setDiscountRate] = useState(0.06);
  const [scenarioName, setScenarioName] = useState("");
  const path = { orgId, buildingId };

  const strategies = useQuery({
    queryKey: ["strategies", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/strategies", { params: { path } })),
  });
  const epc = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/epc", {
          params: { path },
          body: { strategyId, escoShare, years, achieved, discountRate, annualOpex: 0 },
        }),
      ),
  });
  const scenarios = useQuery({
    queryKey: ["scenarios", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/scenarios", { params: { path } })),
  });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/scenarios", {
          params: { path },
          body: {
            name: scenarioName,
            inputs: { strategyId, escoShare, years, achieved, discountRate, annualOpex: 0 },
          },
        }),
      ),
    onSuccess: () => {
      setScenarioName("");
      qc.invalidateQueries({ queryKey: ["scenarios", orgId, buildingId] });
    },
  });

  // recompute whenever an input changes; the API is the single source of the finance model
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs are the trigger
  useEffect(() => {
    const id = setTimeout(() => epc.mutate(), 250);
    return () => clearTimeout(id);
  }, [strategyId, escoShare, years, achieved, discountRate]);

  if (strategies.isPending) return <Loading />;
  if (strategies.error) return <ErrorBox error={strategies.error} onRetry={() => strategies.refetch()} />;
  const s = strategies.data;
  const r = epc.data;
  const years$ = (v: number | null | undefined) =>
    v === null || v === undefined ? t.simulate.never : `${num(v, locale, 1)} ${t.simulate.years}`;

  return (
    <>
      <PageHeader title={t.simulate.title} subtitle={t.simulate.subtitle} />
      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {s.strategies.map((x) => (
          <button
            type="button"
            key={x.id}
            onClick={() => setStrategyId(x.id as StrategyId)}
            className={`rounded-xl border bg-surface p-4 text-left transition-colors ${strategyId === x.id ? "border-accent ring-2 ring-[var(--ring)]" : "border-border hover:bg-surface-2"}`}
          >
            <div className="font-semibold">{t.domain.strategies[x.id]?.name ?? x.name}</div>
            <p className="mt-1 line-clamp-3 text-xs text-muted">
              {t.domain.strategies[x.id]?.description ?? x.description}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted">{t.simulate.annualKwh}</dt>
                <dd className="num font-semibold text-saving">{kwh(x.annualKwh, locale)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t.simulate.annualCost}</dt>
                <dd className="num font-semibold">{money(x.annualCost, locale, cur)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t.simulate.capex}</dt>
                <dd className="num">{money(x.capex, locale, cur)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t.simulate.payback}</dt>
                <dd className="num">
                  {x.annualCost > 0
                    ? `${num(x.capex / x.annualCost, locale, 1)} ${t.simulate.years}`
                    : t.simulate.never}
                </dd>
              </div>
            </dl>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.6fr]">
        <Card title={t.simulate.epc}>
          <div className="space-y-4">
            <Field label={t.simulate.strategy}>
              <Select value={strategyId} onChange={(e) => setStrategyId(e.target.value as StrategyId)}>
                {s.strategies.map((x) => (
                  <option key={x.id} value={x.id}>
                    {t.domain.strategies[x.id]?.name ?? x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`${t.simulate.escoShare}: ${pct(escoShare, locale)}`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={escoShare}
                onChange={(e) => setEscoShare(Number(e.target.value))}
                className="accent-[var(--accent)]"
              />
            </Field>
            <Field label={`${t.simulate.achieved}: ${pct(achieved, locale)}`}>
              <input
                type="range"
                min={0.5}
                max={1.2}
                step={0.05}
                value={achieved}
                onChange={(e) => setAchieved(Number(e.target.value))}
                className="accent-[var(--accent)]"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.simulate.contractYears}>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={years}
                  onChange={(e) => setYears(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                />
              </Field>
              <Field label={t.simulate.discount}>
                <Input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={discountRate}
                  onChange={(e) => setDiscountRate(Math.max(0, Math.min(0.5, Number(e.target.value) || 0)))}
                />
              </Field>
            </div>
            {can.saveScenario(role) ? (
              <div className="flex gap-2 border-t border-border pt-4">
                <Input
                  placeholder={t.simulate.scenarioName}
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  maxLength={120}
                />
                <Button onClick={() => save.mutate()} disabled={!scenarioName.trim()} busy={save.isPending}>
                  {t.simulate.saveScenario}
                </Button>
              </div>
            ) : null}
            {scenarios.data?.length ? (
              <div className="text-sm">
                <div className="mb-1 text-xs font-semibold text-muted">{t.simulate.scenarios}</div>
                <ul className="space-y-1">
                  {scenarios.data.map((sc) => (
                    <li key={sc.id}>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => {
                          setStrategyId(sc.strategyId as StrategyId);
                          setEscoShare(sc.inputs.escoShare ?? 0.6);
                          setYears(sc.inputs.years ?? 5);
                          setAchieved(sc.inputs.achieved ?? 1);
                          setDiscountRate(sc.inputs.discountRate ?? 0.06);
                        }}
                      >
                        {sc.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {save.error ? <ErrorBox error={save.error} /> : null}
          </div>
        </Card>

        <div className="space-y-6">
          {epc.error ? <ErrorBox error={epc.error} /> : null}
          {r ? (
            <>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                <Metric
                  label={t.simulate.ownerAnnual}
                  value={money(r.ownerAnnual, locale, cur)}
                  tone="saving"
                />
                <Metric label={t.simulate.escoAnnual} value={money(r.escoAnnual, locale, cur)} />
                <Metric label={t.simulate.escoPayback} value={years$(r.escoPaybackYears)} />
                <Metric label={t.simulate.selfPayback} value={years$(r.selfFundedPaybackYears)} />
                <Metric label={t.simulate.ownerNpv} value={money(r.ownerNpv, locale, cur)} />
                <Metric label={t.simulate.escoNpv} value={money(r.escoNpv, locale, cur)} />
              </div>
              <Card title={t.simulate.timeline}>
                <CashflowChart
                  data={r.timeline}
                  locale={locale}
                  labels={{ owner: t.simulate.owner, esco: t.simulate.esco }}
                />
              </Card>
            </>
          ) : (
            <Loading />
          )}
          <p className="text-xs text-muted">{t.simulate.simulatedNote}</p>
        </div>
      </div>
    </>
  );
}
