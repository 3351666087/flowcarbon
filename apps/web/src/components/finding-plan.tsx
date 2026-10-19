"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronRight, CircleCheck, Hammer, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { useOwnDemo } from "@/components/demo-banner";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Badge, Button, ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { FindingDetail, Measure, Verification } from "@/lib/api-shapes";
import { dateTime, kwh, type Locale, money } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, type Role } from "@/lib/session";

type Dict = ReturnType<typeof useI18n>["t"];

/** what the AI assistant recommended for this finding, from its latest finished explanation */
export interface Recommendation {
  strategyId: string;
  reason: string;
  /** the explanation it came from; none when it came from the building overview */
  explanationId?: string;
}

export const strategyName = (t: Dict, id: string) => t.domain.strategies[id]?.name ?? id;

export const MEASURE_TONE = { planned: "accent", in_effect: "saving", cancelled: "neutral" } as const;

/** One line saying what the data shows about a measure. */
export function verdictLine(
  t: Dict,
  v: Verification,
  locale: Locale,
  currency: string,
): { text: string; tone: "saving" | "accent" | "waste" | "neutral" } {
  const kind = v.dayTypes.length === 1 ? v.dayTypes[0]! : "any";
  const vars = {
    day: t.plan.dayWord[kind] ?? t.plan.dayWord.any!,
    before: kwh(v.before.perDayKwh, locale),
    after: kwh(v.after?.perDayKwh ?? 0, locale),
    kwh: kwh(v.weekly.kwh, locale),
    cost: money(v.weekly.cost, locale, currency),
  };
  const text = fill(t.plan.verdict[v.verdict] ?? "", vars);
  const tone =
    v.verdict === "working"
      ? "saving"
      : v.verdict === "not_working"
        ? "waste"
        : v.verdict === "partly"
          ? "accent"
          : "neutral";
  return { text, tone };
}

interface Ctx {
  f: FindingDetail;
  path: { orgId: string; buildingId: string; findingId: string };
  floorLabel: string;
  currency: string;
  timeZone: string;
}

type SheetState =
  | { kind: "plan"; mode: "new" | "edit" | "change" }
  | { kind: "dismiss" }
  | { kind: "threshold"; key: string }
  | null;

/**
 * Everything a reviewer can do with a finding: adopt the assistant's recommendation (as it stands or edited), choose
 * a measure, dismiss with a reason, mark it fixed on site; and for its measure, mark it in effect, change it or
 * cancel it. Each step can be undone from the note that confirms it.
 */
export function usePlan(ctx: Ctx, rec: Recommendation | null) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<SheetState>(null);
  const { f, path } = ctx;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["finding", path.findingId] });
    qc.invalidateQueries({ queryKey: ["findings"] });
    qc.invalidateQueries({ queryKey: ["measures"] });
    qc.invalidateQueries({ queryKey: ["measure"] });
  };

  const patchMeasure = (
    measureId: string,
    body: { status?: "planned" | "in_effect" | "cancelled"; strategyId?: string; note?: string | null },
  ) =>
    unwrap(
      api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures/{measureId}", {
        params: { path: { orgId: path.orgId, buildingId: path.buildingId, measureId } },
        body: body as never,
      }),
    );
  const patchFinding = (status: "open" | "acknowledged" | "fixed" | "dismissed", note?: string) =>
    unwrap(
      api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}", {
        params: { path },
        body: { status, note },
      }),
    );

  const adopt = useMutation({
    mutationFn: (body: {
      strategyId: string;
      note?: string;
      source: "ai" | "ai_edited" | "manual";
      similar: boolean;
    }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}/measure", {
          params: { path },
          body: { ...body, explanationId: rec?.explanationId || undefined } as never,
        }),
      ),
    onSuccess: (r) => {
      feel("confirm");
      refresh();
      toast(
        r.joined ? fill(t.plan.joined, { floor: ctx.floorLabel }) : fill(t.plan.adopted, { n: r.linked }),
        {
          label: t.plan.undo,
          run: async () => {
            if (r.joined) await patchFinding("open");
            else await patchMeasure(r.measure.id, { status: "cancelled" });
            refresh();
          },
        },
      );
    },
    onError: () => feel("reject"),
  });

  const measureStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "planned" | "in_effect" | "cancelled" }) =>
      patchMeasure(id, { status }),
    onSuccess: (m, { id, status }) => {
      feel(status === "cancelled" ? "press" : "confirm");
      refresh();
      if (status === "in_effect")
        toast(fill(t.plan.done, { n: m.findings.fixed }), {
          label: t.plan.undo,
          run: async () => {
            await patchMeasure(id, { status: "planned" });
            refresh();
          },
        });
      else if (status === "cancelled") toast(t.plan.cancelled);
    },
    onError: () => feel("reject"),
  });

  const findingStatus = useMutation({
    mutationFn: ({ status, note }: { status: "open" | "fixed" | "dismissed"; note?: string }) =>
      patchFinding(status, note),
    onSuccess: (_r, { status }) => {
      feel(status === "open" ? "press" : "confirm");
      const before = f.status;
      const beforeNote = f.statusNote ?? undefined;
      refresh();
      toast(
        status === "dismissed"
          ? t.plan.dismissed
          : status === "open"
            ? t.plan.reopened
            : t.plan.fixedOnSiteNote,
        {
          label: t.plan.undo,
          run: async () => {
            await patchFinding(before === "dismissed" && !beforeNote ? "open" : before, beforeNote);
            refresh();
          },
        },
      );
    },
    onError: () => feel("reject"),
  });

  /** the assistant's recommendation, as it stands */
  const adoptAsSuggested = () => {
    if (!rec) return;
    if (rec.strategyId === "no_action") findingStatus.mutate({ status: "dismissed", note: rec.reason });
    else adopt.mutate({ strategyId: rec.strategyId, note: rec.reason, source: "ai", similar: true });
  };

  return {
    sheet,
    open: setSheet,
    adopt,
    measureStatus,
    findingStatus,
    adoptAsSuggested,
    patchMeasure,
    refresh,
    busy: adopt.isPending || measureStatus.isPending || findingStatus.isPending,
  };
}
export type PlanApi = ReturnType<typeof usePlan>;

/** The "what to do" card: the next step for this finding, depending on where it stands and who is looking. */
export function PlanCard({
  ctx,
  plan,
  rec,
  role,
  sharedDemo,
}: {
  ctx: Ctx;
  plan: PlanApi;
  rec: Recommendation | null;
  role?: Role;
  sharedDemo: boolean;
}) {
  const { t, locale } = useI18n();
  const { f } = ctx;
  const m = f.measureDetail;
  const reviewer = can.reviewFindings(role);
  const error = plan.adopt.error ?? plan.measureStatus.error ?? plan.findingStatus.error;

  let body: ReactNode;
  if (m && m.status !== "cancelled")
    body = <MeasureSummary ctx={ctx} plan={plan} m={m} reviewer={reviewer} />;
  else if (f.status === "dismissed")
    body = (
      <Settled
        icon={<X className="size-4" aria-hidden />}
        text={fill(t.plan.dismissedBecause, { note: f.statusNote ?? "–" })}
        meta={who(f.reviewedBy, f.statusAt, locale, ctx.timeZone)}
        action={
          reviewer ? (
            <Button
              variant="ghost"
              busy={plan.findingStatus.isPending}
              onClick={() => plan.findingStatus.mutate({ status: "open" })}
            >
              <RotateCcw className="size-4" aria-hidden /> {t.plan.restore}
            </Button>
          ) : null
        }
      />
    );
  else if (f.status === "fixed")
    body = (
      <Settled
        icon={<CircleCheck className="size-4" aria-hidden />}
        text={fill(t.plan.fixedBy, { name: f.reviewedBy ?? t.plan.someone })}
        meta={
          f.statusNote && f.statusNote !== t.plan.fixedOnSiteNote
            ? f.statusNote
            : dateTime(f.statusAt, locale, ctx.timeZone)
        }
        action={
          reviewer ? (
            <Button
              variant="ghost"
              busy={plan.findingStatus.isPending}
              onClick={() => plan.findingStatus.mutate({ status: "open" })}
            >
              <RotateCcw className="size-4" aria-hidden /> {t.plan.reopen}
            </Button>
          ) : null
        }
      />
    );
  else if (!reviewer) body = <ReadOnly role={role} sharedDemo={sharedDemo} />;
  else
    body = (
      <div className="space-y-3">
        {/* the assistant's recommendation is adopted from the explanation itself, next to its reasons */}
        {rec ? (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            {t.plan.seeAi}
          </p>
        ) : (
          <p className="text-sm text-muted">{t.plan.noAiYet}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={rec ? "secondary" : "primary"}
            onClick={() => plan.open({ kind: "plan", mode: "new" })}
          >
            {rec ? t.plan.otherChoice : t.plan.choose}
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
          <button
            type="button"
            className="font-medium text-muted hover:text-text"
            onClick={() => plan.open({ kind: "dismiss" })}
          >
            {t.plan.dismiss}
          </button>
          <button
            type="button"
            className="font-medium text-muted hover:text-text"
            onClick={() => plan.findingStatus.mutate({ status: "fixed", note: t.plan.fixedOnSiteNote })}
          >
            {t.plan.fixedOnSite}
          </button>
        </div>
      </div>
    );

  return (
    <div>
      {body}
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </div>
  );
}

function who(name: string | null, at: string | null, locale: Locale, tz: string) {
  return [name ?? null, at ? dateTime(at, locale, tz) : null].filter(Boolean).join(" · ") || null;
}

function Settled({
  icon,
  text,
  meta,
  action,
}: {
  icon: ReactNode;
  text: string;
  meta: string | null;
  action: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-sm">
        <span className="mt-0.5 text-muted">{icon}</span>
        <span>
          <span className="font-medium">{text}</span>
          {meta ? <span className="mt-0.5 block text-xs text-muted">{meta}</span> : null}
        </span>
      </p>
      {action}
    </div>
  );
}

function ReadOnly({ role, sharedDemo }: { role?: Role; sharedDemo: boolean }) {
  const { t } = useI18n();
  const own = useOwnDemo();
  if (sharedDemo)
    return (
      <div className="space-y-3">
        <p className="text-sm">{t.plan.readOnlyDemo}</p>
        <Button variant="primary" busy={own.busy} onClick={own.start}>
          {t.plan.getDemo}
        </Button>
      </div>
    );
  return (
    <p className="text-sm text-muted">
      {fill(t.plan.readOnly, { role: role ? (t.settings.roles[role] ?? role) : "–" })}
    </p>
  );
}

function MeasureSummary({
  ctx,
  plan,
  m,
  reviewer,
}: {
  ctx: Ctx;
  plan: PlanApi;
  m: Measure;
  reviewer: boolean;
}) {
  const { t, locale } = useI18n();
  const v = verdictLine(t, m.verification, locale, ctx.currency);
  const href = `/o/${ctx.path.orgId}/b/${ctx.path.buildingId}/measures/${m.id}`;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-surface-2 p-3.5">
        <div className="flex items-center gap-2">
          <Hammer className="size-4 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-semibold">{strategyName(t, m.strategyId)}</span>
          <Badge tone={MEASURE_TONE[m.status]}>{t.plan.statuses[m.status]}</Badge>
        </div>
        {m.note ? <p className="mt-2 text-sm whitespace-pre-line">{m.note}</p> : null}
        <p className="mt-2 text-xs text-muted">
          {fill(t.plan.agreed, {
            name: m.createdBy ?? t.plan.someone,
            date: dateTime(m.createdAt, locale, ctx.timeZone, { timeStyle: undefined }),
            source: t.plan.sources[m.source] ?? m.source,
          })}
          {" · "}
          {fill(t.plan.covers, { n: m.findings.total, floor: m.floorLabel })}
        </p>
      </div>
      <p
        className={clsx("text-sm", v.tone === "saving" && "text-saving", v.tone === "waste" && "text-waste")}
      >
        {v.text}
      </p>
      {m.status === "in_effect" && m.verification.after?.recurrences ? (
        <p className="text-xs text-muted">{fill(t.plan.recurred, { n: m.verification.after.recurrences })}</p>
      ) : null}
      {reviewer ? (
        m.status === "planned" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                busy={plan.measureStatus.isPending}
                onClick={() => plan.measureStatus.mutate({ id: m.id, status: "in_effect" })}
              >
                <Check className="size-4" aria-hidden /> {t.plan.markDone}
              </Button>
              <Button variant="secondary" onClick={() => plan.open({ kind: "plan", mode: "change" })}>
                {t.plan.change}
              </Button>
            </div>
            <p className="text-xs text-muted">{t.plan.markDoneHint}</p>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              busy={plan.measureStatus.isPending}
              onClick={() => plan.measureStatus.mutate({ id: m.id, status: "planned" })}
            >
              <Undo2 className="size-4" aria-hidden /> {t.plan.undoDone}
            </Button>
          </div>
        )
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-accent">
          {t.plan.details} <ChevronRight className="size-4" aria-hidden />
        </Link>
        {reviewer ? (
          <ConfirmText
            label={t.plan.cancel}
            onConfirm={() => plan.measureStatus.mutate({ id: m.id, status: "cancelled" })}
          />
        ) : null}
      </div>
    </div>
  );
}

/** A quiet text button that asks once more before doing something that cannot be undone. */
export function ConfirmText({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const { locale } = useI18n();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => {
        if (armed) onConfirm();
        else {
          feel("tick");
          setArmed(true);
        }
      }}
      className={clsx("text-sm font-medium", armed ? "text-danger" : "text-muted hover:text-text")}
    >
      {armed ? (locale === "zh" ? `确定${label}？` : `${label}?`) : label}
    </button>
  );
}

/** Choosing (or changing) a measure: the strategies that fit, a note for whoever carries it out, and its reach. */
export function PlanSheet({
  ctx,
  plan,
  rec,
  mode,
  onClose,
}: {
  ctx: Ctx;
  plan: PlanApi;
  rec: Recommendation | null;
  mode: "new" | "edit" | "change";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { f } = ctx;
  const m = f.measureDetail;
  const suggested = rec && rec.strategyId !== "no_action" ? rec.strategyId : null;
  const choices = [...new Set([...(suggested ? [suggested] : []), ...f.options.fits])];
  const [strategyId, setStrategyId] = useState(
    mode === "change" && m ? m.strategyId : (suggested ?? f.options.fits[0] ?? "investigate_on_site"),
  );
  const [note, setNote] = useState(
    mode === "change" ? (m?.note ?? "") : mode === "edit" ? (rec?.reason ?? "") : "",
  );
  const [similar, setSimilar] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const others = f.options.similar[strategyId] ?? 0;
  const joins =
    mode !== "change" ? f.options.floorMeasures.find((x) => x.strategyId === strategyId) : undefined;

  const submit = async (close: () => void) => {
    setError(null);
    if (mode === "change" && m) {
      setSaving(true);
      try {
        await plan.patchMeasure(m.id, { strategyId, note: note.trim() || null });
        feel("confirm");
        plan.refresh();
        close();
      } catch (e) {
        setError(e);
        feel("reject");
      } finally {
        setSaving(false);
      }
      return;
    }
    const source = !rec
      ? "manual"
      : strategyId === rec.strategyId && note.trim() === rec.reason.trim()
        ? "ai"
        : "ai_edited";
    plan.adopt.mutate(
      { strategyId, note: note.trim() || undefined, source, similar },
      { onSuccess: close, onError: (e) => setError(e) },
    );
  };

  return (
    <Sheet
      title={mode === "change" ? t.plan.sheetEditTitle : t.plan.sheetTitle}
      onClose={onClose}
      footer={(close) => (
        <Button
          variant="primary"
          className="w-full justify-center"
          busy={saving || plan.adopt.isPending}
          onClick={() => submit(close)}
        >
          {mode === "change" ? t.plan.save : t.plan.submit}
        </Button>
      )}
    >
      <p className="mb-3 text-xs text-muted">{t.plan.fitsNote}</p>
      <fieldset className="space-y-2">
        <legend className="sr-only">{t.plan.sheetTitle}</legend>
        {choices.map((id) => (
          <label
            key={id}
            className={clsx(
              "fc-press flex cursor-pointer gap-3 rounded-2xl border p-3",
              strategyId === id ? "border-accent bg-accent-soft" : "border-border bg-surface",
            )}
          >
            <input
              type="radio"
              name="strategy"
              value={id}
              checked={strategyId === id}
              onChange={() => {
                feel("tick");
                setStrategyId(id);
              }}
              className="mt-1 accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{strategyName(t, id)}</span>
                {id === suggested ? (
                  <Badge tone="accent">
                    <Sparkles className="size-3" aria-hidden /> {t.plan.aiPick}
                  </Badge>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-muted">{t.domain.strategies[id]?.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium">{t.plan.note}</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder={t.plan.notePlaceholder}
          className="w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>
      {mode !== "change" && others > 0 && !joins ? (
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={similar}
            onChange={(e) => setSimilar(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--accent)]"
          />
          <span>{fill(t.plan.similar, { n: others, floor: ctx.floorLabel })}</span>
        </label>
      ) : null}
      {joins ? (
        <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">
          {fill(t.plan.joins, {
            floor: ctx.floorLabel,
            status: t.plan.statuses[joins.status] ?? joins.status,
          })}
        </p>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Sheet>
  );
}

const REASONS = ["overtime", "data", "maintenance", "threshold", "other"] as const;

/** Dismissing asks why, with the usual reasons one tap away. */
export function DismissSheet({
  plan,
  onClose,
  onAdjust,
}: {
  plan: PlanApi;
  onClose: () => void;
  /** offered with "the threshold does not fit" to people who may change it */
  onAdjust?: () => void;
}) {
  const { t, locale } = useI18n();
  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [detail, setDetail] = useState("");
  const ready = !!reason && (reason !== "other" || detail.trim().length > 0);
  return (
    <Sheet
      title={t.plan.dismissTitle}
      onClose={onClose}
      footer={(close) => (
        <Button
          variant="danger"
          className="w-full justify-center"
          disabled={!ready}
          busy={plan.findingStatus.isPending}
          onClick={() => {
            const label = reason === "other" ? "" : t.plan.reasons[reason!]!;
            const note = [label, detail.trim()].filter(Boolean).join(locale === "zh" ? "：" : ": ");
            plan.findingStatus.mutate({ status: "dismissed", note }, { onSuccess: close });
          }}
        >
          {t.plan.dismiss}
        </Button>
      )}
    >
      <div className="flex flex-wrap gap-2">
        {REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => {
              feel("tick");
              setReason(r);
            }}
            className={clsx(
              "fc-press rounded-full px-3.5 py-2 text-sm font-medium",
              reason === r ? "bg-text text-bg" : "border border-border bg-surface text-muted",
            )}
          >
            {t.plan.reasons[r]}
          </button>
        ))}
      </div>
      {reason === "threshold" && onAdjust ? (
        <button
          type="button"
          onClick={onAdjust}
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent"
        >
          {t.plan.adjustInstead} <ChevronRight className="size-4" aria-hidden />
        </button>
      ) : null}
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium">
          {reason === "other" ? t.plan.detailRequired : t.plan.detail}
        </span>
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={3}
          maxLength={900}
          className="w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>
    </Sheet>
  );
}

/** Adopting the assistant's recommendation where it is explained: as it stands, or edited first. */
export function AiActions({ plan, rec }: { plan: PlanApi; rec: Recommendation }) {
  const { t } = useI18n();
  return (
    <>
      <Button
        variant="primary"
        busy={plan.adopt.isPending || plan.findingStatus.isPending}
        onClick={plan.adoptAsSuggested}
      >
        <Check className="size-4" aria-hidden />{" "}
        {rec.strategyId === "no_action" ? t.plan.dismissAsSuggested : t.plan.adopt}
      </Button>
      {rec.strategyId !== "no_action" ? (
        <Button variant="secondary" onClick={() => plan.open({ kind: "plan", mode: "edit" })}>
          {t.plan.adoptEdit}
        </Button>
      ) : null}
    </>
  );
}
