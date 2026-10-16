"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Lock } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Loading,
  Metric,
  PageHeader,
  Table,
} from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { addDays, co2, dateTime, kwh, money, num, pct } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { can, useBuilding, useIds, useMembership } from "@/lib/session";

export default function ReportPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const path = { orgId, buildingId };
  const cur = building!.currency;
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [draft, setDraft] = useState<{ from?: string; to?: string }>({});

  const report = useQuery({
    queryKey: ["report", orgId, buildingId, range.from, range.to],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/report", {
          params: { path, query: { from: range.from, to: range.to } },
        }),
      ),
  });
  const snapshots = useQuery({
    queryKey: ["snapshots", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/report-snapshots", { params: { path } })),
  });
  const r = report.data && typeof report.data === "object" ? report.data : null;
  const periodFrom = r
    ? new Intl.DateTimeFormat("en-CA", { timeZone: building!.timezone }).format(new Date(r.period.from))
    : undefined;
  const periodTo = r
    ? new Intl.DateTimeFormat("en-CA", { timeZone: building!.timezone }).format(new Date(r.period.to))
    : undefined;
  const freeze = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/report-snapshots", {
          params: { path },
          body: { from: periodFrom!, to: periodTo! },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshots", orgId, buildingId] }),
  });

  if (report.isPending) return <Loading />;
  if (report.error || !r) return <ErrorBox error={report.error} onRetry={() => report.refetch()} />;
  const csvHref = `/api/v1/orgs/${orgId}/buildings/${buildingId}/report?format=csv&from=${periodFrom}&to=${periodTo}`;
  const factor = (f: { kgPerKwh: number; source: string; year: number; region: string; status: string }) => (
    <span className="text-xs text-muted">
      {f.kgPerKwh} kgCO₂e/kWh · {f.region} {f.year} ·{" "}
      <Badge tone={f.status === "verified" ? "saving" : "waste"}>
        {f.status === "verified" ? t.report.verified : t.report.toVerify}
      </Badge>
      <span className="mt-1 block break-all">{f.source}</span>
    </span>
  );

  return (
    <>
      <PageHeader
        title={t.report.title}
        subtitle={t.report.subtitle}
        actions={
          <>
            <a
              href={csvHref}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2"
            >
              <Download className="size-4" aria-hidden /> {t.report.csv}
            </a>
            {can.snapshot(role) ? (
              <Button onClick={() => freeze.mutate()} busy={freeze.isPending}>
                <Lock className="size-4" aria-hidden />{" "}
                {freeze.isSuccess ? t.report.snapshotDone : t.report.snapshot}
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="mb-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setRange(draft);
          }}
        >
          <Field label={t.common.from}>
            <Input
              type="date"
              value={draft.from ?? periodFrom ?? ""}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </Field>
          <Field label={t.common.toExclusive}>
            <Input
              type="date"
              value={draft.to ?? periodTo ?? ""}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </Field>
          <Button type="submit">{t.common.apply}</Button>
          <span className="text-sm text-muted">
            {periodFrom} – {periodTo ? addDays(periodTo, -1) : ""} · {r.period.days} d (
            {Object.entries(r.period.dayTypes)
              .map(([k, v]) => `${t.report.dayTypes[k]} ${v}`)
              .join(", ")}
            )
          </span>
        </form>
      </Card>
      {freeze.error ? (
        <div className="mb-6">
          <ErrorBox error={freeze.error} />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label={t.report.energy}
          value={kwh(r.totals.kwh, locale)}
          sub={`${t.report.afterHours} ${kwh(r.totals.afterHoursKwh, locale)}`}
        />
        <Metric label={t.report.cost} value={money(r.totals.cost, locale, cur)} />
        <Metric
          label={t.report.avoidable}
          value={kwh(r.totals.avoidableKwh, locale)}
          sub={`${money(r.totals.avoidableCost, locale, cur)} · ${co2(r.avoidableCo2eKg, locale)}`}
          tone="waste"
        />
        <Metric label={t.floors.measuredShare} value={pct(r.totals.measuredShare, locale)} tone="accent" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title={`Scope 2 · ${t.report.location}`}>
          <div className="num text-2xl font-semibold">{co2(r.scope2.locationBasedKg, locale)}</div>
          <div className="mt-2">{factor(r.scope2.locationFactor)}</div>
        </Card>
        <Card title={`Scope 2 · ${t.report.market}`}>
          <div className="num text-2xl font-semibold">{co2(r.scope2.marketBasedKg, locale)}</div>
          <div className="mt-1 text-sm">
            {t.report.green}: {pct(r.scope2.greenShare, locale, 1)}
          </div>
          {r.scope2.residualFactor ? <div className="mt-2">{factor(r.scope2.residualFactor)}</div> : null}
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title={t.report.byFloor}>
          <Table head={[t.common.floor, t.report.energy, t.report.afterHours, t.report.avoidable]}>
            {r.byFloor.map((f) => (
              <tr key={f.floorId}>
                <td className="font-medium">{f.label}</td>
                <td className="num">{num(f.kwh, locale)}</td>
                <td className="num">{num(f.afterHoursKwh, locale)}</td>
                <td className="num text-waste">{num(f.avoidableKwh, locale)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <div className="space-y-6">
          <Card title={t.report.byRule}>
            <Table head={[t.findings.rule, "#", t.report.avoidable]}>
              {r.byRule.map((x) => (
                <tr key={x.ruleId}>
                  <td>{t.domain.ruleNames[x.ruleId] ?? x.name}</td>
                  <td className="num">{x.count}</td>
                  <td className="num text-waste">{kwh(x.kwh, locale)}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title={t.report.byDayType}>
            <Table head={["", "d", t.report.energy, t.report.avoidable]}>
              {r.byDayType.map((x) => (
                <tr key={x.dayType}>
                  <td>{t.report.dayTypes[x.dayType]}</td>
                  <td className="num">{x.days}</td>
                  <td className="num">{kwh(x.kwh, locale)}</td>
                  <td className="num text-waste">{kwh(x.avoidableKwh, locale)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>

      <Card title={t.report.disclosures} className="mb-6">
        <ol className="list-decimal space-y-2 pl-5 text-sm [overflow-wrap:anywhere]">
          {r.disclosures.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ol>
      </Card>

      {snapshots.data?.length ? (
        <Card title={t.report.snapshots}>
          <ul className="space-y-1 text-sm">
            {snapshots.data.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-2">
                <Lock className="size-4 text-muted" aria-hidden />
                {dateTime(s.periodFrom, locale, building!.timezone, { timeStyle: undefined })} –{" "}
                {dateTime(s.periodTo, locale, building!.timezone, { timeStyle: undefined })}
                <span className="text-muted">· {dateTime(s.createdAt, locale, building!.timezone)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
