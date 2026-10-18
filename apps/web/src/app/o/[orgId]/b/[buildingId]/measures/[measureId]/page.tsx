"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeft, Check, ChevronRight, Hammer, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ConfirmText, MEASURE_TONE, strategyName, verdictLine } from "@/components/finding-plan";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Badge, Button, Card, ErrorBox, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { MeasureDetail, Verification } from "@/lib/api-shapes";
import { dateTime, day, kwh, type Locale, money } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, useBuilding, useIds, useMembership } from "@/lib/session";

export default function MeasurePage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { measureId } = useParams<{ measureId: string }>();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const path = { orgId, buildingId, measureId };
  const tz = building!.timezone;
  const currency = building!.currency;

  const q = useQuery({
    queryKey: ["measure", measureId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures/{measureId}", { params: { path } }),
      ),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["measure", measureId] });
    qc.invalidateQueries({ queryKey: ["measures"] });
    qc.invalidateQueries({ queryKey: ["finding"] });
    qc.invalidateQueries({ queryKey: ["findings"] });
  };
  const patch = useMutation({
    mutationFn: (body: { status?: "planned" | "in_effect" | "cancelled"; note?: string | null }) =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures/{measureId}", {
          params: { path },
          body: body as never,
        }),
      ),
    onSuccess: (m, body) => {
      feel(body.status === "cancelled" ? "press" : "confirm");
      refresh();
      if (body.status === "in_effect")
        toast(fill(t.plan.done, { n: m.findings.fixed }), {
          label: t.plan.undo,
          run: () => patch.mutate({ status: "planned" }),
        });
      if (body.status === "cancelled") toast(t.plan.cancelled);
    },
    onError: () => feel("reject"),
  });

  if (q.isPending) return <Loading page />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const m = q.data as MeasureDetail;
  const v = verdictLine(t, m.verification, locale, currency);
  const reviewer = can.reviewFindings(role);
  const findingHref = (id: string) => `/o/${orgId}/b/${buildingId}/findings/${id}`;
  const measured = m.status === "in_effect" && m.verification.verdict !== "waiting";

  return (
    <>
      <Link
        href={`/o/${orgId}/b/${buildingId}/measures`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t.measures.back}
      </Link>
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl">
            <Hammer className="size-5 shrink-0 text-accent" aria-hidden />
            <span>
              {m.floorLabel} · {strategyName(t, m.strategyId)}
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            {fill(t.plan.agreed, {
              name: m.createdBy ?? t.plan.someone,
              date: dateTime(m.createdAt, locale, tz, { timeStyle: undefined }),
              source: t.plan.sources[m.source] ?? m.source,
            })}
          </p>
        </div>
        <Badge tone={MEASURE_TONE[m.status]}>{t.plan.statuses[m.status]}</Badge>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card>
            <p className="text-xs text-muted">
              {measured ? t.measures.measured : t.measures.expected} · {t.measures.week}
            </p>
            <p className={clsx("num mt-1 text-3xl font-semibold", measured && "text-saving")}>
              {kwh(m.verification.weekly.kwh, locale)}
              <span className="ml-2 text-base font-medium text-muted">
                {money(m.verification.weekly.cost, locale, currency)}
              </span>
            </p>
            <p
              className={clsx(
                "mt-3 text-sm",
                v.tone === "saving" && "text-saving",
                v.tone === "waste" && "text-waste",
              )}
            >
              {v.text}
            </p>
            {m.status === "in_effect" && m.verification.after?.recurrences ? (
              <p className="mt-1 text-xs text-muted">
                {fill(t.plan.recurred, { n: m.verification.after.recurrences })}
              </p>
            ) : null}
          </Card>
          <Card title={t.measures.chart}>
            <BeforeAfter v={m.verification} locale={locale} />
          </Card>
          {m.recurring.length ? (
            <Card title={t.measures.recurring}>
              <FindingRows items={m.recurring} href={findingHref} tz={tz} currency={currency} />
            </Card>
          ) : null}
          <Card title={t.measures.linked}>
            {m.linked.length ? (
              <FindingRows items={m.linked} href={findingHref} tz={tz} currency={currency} />
            ) : (
              <p className="text-sm text-muted">–</p>
            )}
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card title={t.plan.note}>
            <p className="text-sm whitespace-pre-line">{m.note || "–"}</p>
            {reviewer && m.status !== "cancelled" ? (
              <button
                type="button"
                className="mt-3 text-sm font-medium text-accent"
                onClick={() => setEditing(true)}
              >
                {t.plan.change}
              </button>
            ) : null}
          </Card>
          {reviewer && m.status !== "cancelled" ? (
            <Card title={t.plan.title}>
              {m.status === "planned" ? (
                <>
                  <Button
                    variant="primary"
                    busy={patch.isPending}
                    onClick={() => patch.mutate({ status: "in_effect" })}
                  >
                    <Check className="size-4" aria-hidden /> {t.plan.markDone}
                  </Button>
                  <p className="mt-2 text-xs text-muted">{t.plan.markDoneHint}</p>
                </>
              ) : (
                <>
                  <p className="text-sm">
                    {fill(t.plan.inEffectSince, { date: dateTime(m.implementedAt, locale, tz) })}
                    {m.implementedBy ? ` · ${m.implementedBy}` : ""}
                  </p>
                  <Button
                    className="mt-3"
                    variant="ghost"
                    busy={patch.isPending}
                    onClick={() => patch.mutate({ status: "planned" })}
                  >
                    <Undo2 className="size-4" aria-hidden /> {t.plan.undoDone}
                  </Button>
                </>
              )}
              <div className="mt-4 border-t border-border pt-3">
                <ConfirmText label={t.plan.cancel} onConfirm={() => patch.mutate({ status: "cancelled" })} />
              </div>
              {patch.error ? (
                <div className="mt-3">
                  <ErrorBox error={patch.error} />
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>

      {editing ? (
        <NoteSheet
          note={m.note ?? ""}
          busy={patch.isPending}
          onSave={(note, close) => patch.mutate({ note: note.trim() || null }, { onSuccess: close })}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function NoteSheet({
  note,
  busy,
  onSave,
  onClose,
}: {
  note: string;
  busy: boolean;
  onSave: (note: string, close: () => void) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(note);
  return (
    <Sheet
      title={t.plan.note}
      onClose={onClose}
      footer={(close) => (
        <Button
          variant="primary"
          className="w-full justify-center"
          busy={busy}
          onClick={() => onSave(value, close)}
        >
          {t.plan.save}
        </Button>
      )}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        maxLength={2000}
        placeholder={t.plan.notePlaceholder}
        className="w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm"
      />
    </Sheet>
  );
}

/**
 * The covered waste on the floor per day: before the change, the day it took effect, and after. Days the measure
 * does not act on are drawn faint; today, still incomplete, at half strength.
 */
function BeforeAfter({ v, locale }: { v: Verification; locale: Locale }) {
  const { t } = useI18n();
  const max = Math.max(1, ...v.series.map((d) => d.kwh));
  const change = v.series.find((d) => d.phase === "change");
  const first = v.series[0];
  const last = v.series.at(-1);
  const kind = v.dayTypes.length === 1 ? v.dayTypes[0]! : "any";
  const changeAt = change ? (v.series.indexOf(change) + 0.5) / v.series.length : -1;
  const perDay = (value: number) =>
    fill(t.measures.perDayValue, { value: kwh(value, locale), day: t.plan.dayWord[kind] ?? "" });
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]" role="img" aria-label={t.measures.chart}>
        {v.series.map((d) => (
          <div
            key={d.date}
            title={`${day(d.date, locale)} · ${kwh(d.kwh, locale)}`}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
          >
            <div
              className={clsx(
                "w-full rounded-t-[3px]",
                !d.covered
                  ? "bg-border"
                  : d.phase === "before"
                    ? "bg-waste"
                    : d.phase === "change"
                      ? "bg-accent"
                      : "bg-saving",
                !d.complete && "opacity-50",
              )}
              style={{ height: `${Math.max(d.kwh > 0 ? 4 : 1.5, (d.kwh / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-muted">
        <span className="absolute left-0">
          {first ? day(first.date, locale, { month: "short", day: "numeric" }) : ""}
        </span>
        {change && change !== last && changeAt > 0.15 && changeAt < 0.85 ? (
          <span className="absolute -translate-x-1/2 text-accent" style={{ left: `${changeAt * 100}%` }}>
            {day(change.date, locale, { month: "short", day: "numeric" })}
          </span>
        ) : null}
        <span className="absolute right-0">
          {last ? day(last.date, locale, { month: "short", day: "numeric" }) : ""}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-waste" /> {t.measures.before}
          <span className="num font-medium text-text">{perDay(v.before.perDayKwh)}</span>
        </span>
        {change ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-accent" /> {t.measures.change}
          </span>
        ) : null}
        {v.after ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-saving" /> {t.measures.after}
            {v.after.days ? (
              <span className="num font-medium text-text">{perDay(v.after.perDayKwh)}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted">
        {fill(t.measures.basis, { days: t.plan.dayWord[kind] ?? "" })}
      </p>
    </div>
  );
}

function FindingRows({
  items,
  href,
  tz,
  currency,
}: {
  items: MeasureDetail["linked"];
  href: (id: string) => string;
  tz: string;
  currency: string;
}) {
  const { t, locale } = useI18n();
  return (
    <ul className="-my-1 divide-y divide-border">
      {items.slice(0, 60).map((f) => (
        <li key={f.id}>
          <Link href={href(f.id)} className="fc-press flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {t.domain.ruleNames[f.ruleId] ?? f.ruleName}
              </span>
              <span className="block text-xs text-muted">
                {dateTime(f.startAt, locale, tz)} · {kwh(f.avoidableKwh, locale)} ·{" "}
                {money(f.avoidableCost, locale, currency)}
              </span>
            </span>
            <Badge tone={f.status === "fixed" ? "saving" : f.status === "open" ? "waste" : "accent"}>
              {t.findings.statuses[f.status]}
            </Badge>
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
