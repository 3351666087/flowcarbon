"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDot, Hammer, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { strategyName } from "@/components/finding-plan";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Badge, Button, ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { FindingDetail } from "@/lib/api-shapes";
import { dateTime, todayIn } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";

type Dict = ReturnType<typeof useI18n>["t"];
type Value = number | string;

/** A threshold as people read it: 0.2 of full lighting is 20 %. */
function show(t: Dict, key: string, v: Value) {
  const unit = t.plan.params[key]?.unit ?? "";
  if (key === "lightsMinLevel" && typeof v === "number") return `${Math.round(v * 100)} %`;
  return unit ? `${v} ${unit}` : String(v);
}

/** The thresholds a finding was judged by, what each one means, and (for managers) a way to change them. */
export function ThresholdsCard({
  f,
  canEdit,
  onAdjust,
}: {
  f: FindingDetail;
  canEdit: boolean;
  onAdjust: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-3 text-xs text-muted">{t.plan.thresholdsHint}</p>
      <ul className="divide-y divide-border">
        {f.thresholds.map((th) => {
          const meta = t.plan.params[th.key];
          return (
            <li key={th.key} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{meta?.label ?? th.key}</span>
                  <span className="num text-sm font-semibold">{show(t, th.key, th.value)}</span>
                  <Badge tone={th.value === th.defaultValue ? "neutral" : "accent"}>
                    {th.value === th.defaultValue ? t.plan.default : t.plan.custom}
                  </Badge>
                </div>
                {meta ? <p className="mt-0.5 text-xs text-muted">{meta.meaning}</p> : null}
                {th.current !== th.value ? (
                  <p className="mt-0.5 text-xs text-accent">
                    {fill(t.plan.nowUses, { value: show(t, th.key, th.current) })}
                  </p>
                ) : null}
              </div>
              {canEdit ? (
                <Button variant="ghost" className="h-8 shrink-0 px-3" onClick={() => onAdjust(th.key)}>
                  {t.plan.adjust}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Changing one threshold for the building, then checking the last 28 days again with it. Findings someone has
 * already handled keep their status; open ones that no longer hold disappear, new ones appear.
 */
export function ThresholdSheet({
  f,
  thresholdKey,
  building,
  path,
  onClose,
}: {
  f: FindingDetail;
  thresholdKey: string;
  building: { timezone: string; ruleParams: Record<string, unknown> };
  path: { orgId: string; buildingId: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const th = f.thresholds.find((x) => x.key === thresholdKey)!;
  const meta = t.plan.params[thresholdKey];
  const clock = typeof th.defaultValue === "string";
  const percent = thresholdKey === "lightsMinLevel";
  const toInput = (v: Value) => (percent && typeof v === "number" ? String(Math.round(v * 100)) : String(v));
  const [value, setValue] = useState(toInput(th.current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (raw: string, close: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const parsed: Value = clock ? raw : percent ? Number(raw) / 100 : Number(raw);
      const next = { ...building.ruleParams };
      if (parsed === th.defaultValue) delete next[thresholdKey];
      else next[thresholdKey] = parsed;
      await unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}", {
          params: { path },
          body: { ruleParams: next } as never,
        }),
      );
      const today = todayIn(building.timezone);
      const shift = (d: string, days: number) => {
        const x = new Date(`${d}T00:00:00Z`);
        x.setUTCDate(x.getUTCDate() + days);
        return x.toISOString().slice(0, 10);
      };
      await unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/recompute", {
          params: { path },
          body: { fromDate: shift(today, -28), toDateExclusive: shift(today, 1) },
        }),
      );
      feel("confirm");
      toast(t.plan.thresholdSaved);
      qc.invalidateQueries({ queryKey: ["buildings"] });
      // the recompute runs in the background; pick up its result shortly after
      for (const ms of [2500, 8000])
        setTimeout(() => {
          qc.invalidateQueries({ queryKey: ["finding"] });
          qc.invalidateQueries({ queryKey: ["findings"] });
        }, ms);
      close();
    } catch (e) {
      feel("reject");
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={fill(t.plan.adjustTitle, { label: meta?.label ?? thresholdKey })}
      onClose={onClose}
      footer={(close) => (
        <Button
          variant="primary"
          className="w-full justify-center"
          busy={busy}
          disabled={!value || value === toInput(th.current)}
          onClick={() => save(value, close)}
        >
          {t.plan.save}
        </Button>
      )}
    >
      {(close) => (
        <>
          {meta ? <p className="text-sm">{meta.meaning}</p> : null}
          <div className="mt-4 flex items-center gap-3">
            <input
              type={clock ? "time" : "number"}
              inputMode={clock ? undefined : "decimal"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="num h-12 w-40 rounded-2xl border border-border bg-surface px-4 text-lg font-semibold"
            />
            <span className="text-sm text-muted">{percent ? "%" : (meta?.unit ?? "")}</span>
          </div>
          {th.current !== th.defaultValue ? (
            <button
              type="button"
              className="mt-3 text-sm font-medium text-accent"
              onClick={() => save(toInput(th.defaultValue), close)}
            >
              {fill(t.plan.resetDefault, { value: show(t, thresholdKey, th.defaultValue) })}
            </button>
          ) : null}
          <p className="mt-4 text-xs text-muted">{t.plan.adjustHint}</p>
          {error ? (
            <div className="mt-3">
              <ErrorBox error={error} />
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

const ICONS: Record<string, typeof CircleDot> = {
  "finding.explain": Sparkles,
  "measure.create": Hammer,
  "measure.join": Hammer,
  "measure.implement": CircleCheck,
  "measure.cancel": X,
};

/** What happened to this finding and its measure, oldest first. */
export function HistoryCard({ f, timeZone }: { f: FindingDetail; timeZone: string }) {
  const { t, locale } = useI18n();
  if (!f.activity.length) return null;
  return (
    <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[9px] before:w-px before:bg-border">
      {f.activity.map((a) => {
        const Icon = ICONS[a.action] ?? CircleDot;
        const data = a.data ?? {};
        const label = t.findings.statuses[String(data.to)] ?? String(data.to ?? "");
        const note = data.note ? String(data.note) : "";
        const status = note ? (locale === "zh" ? `${label}（${note}）` : `${label} (${note})`) : label;
        const text = fill(t.plan.actions[a.action] ?? a.action, {
          actor: a.actor ?? t.plan.system,
          to: status,
          strategy: strategyName(t, String(data.strategyId ?? "")),
        });
        return (
          <li key={`${a.at}-${a.action}`} className="relative flex gap-3 pl-0">
            <span className="relative z-10 grid size-5 shrink-0 place-items-center rounded-full bg-surface text-muted ring-4 ring-[var(--surface)]">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-sm">
              <span>{text}</span>
              <span className="block text-xs text-muted">{dateTime(a.at, locale, timeZone)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
