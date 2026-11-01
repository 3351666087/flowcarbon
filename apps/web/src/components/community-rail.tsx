"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ShareTarget, type SplitView, useStrategyBoard, useTurns } from "@/components/assistant";
import { Dialog } from "@/components/dialog";
import { feel, tick } from "@/components/glass";
import { toast } from "@/components/toast";
import { Badge, Button, Card, ErrorBox, Field, Input, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { CommunityStrategy, TurnOption } from "@/lib/api-shapes";
import { type Locale, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, useIds, useMembership } from "@/lib/session";

/** How many strategies show before "show all". */
const SHOWN = 5;

const kindOf = (option: TurnOption["id"]) => (option === "community" ? "custom" : option);

/** What the figures rest on, and where the building behind them comes from. One never stands in for the other. */
function Basis({ s }: { s: CommunityStrategy }) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {s.result.basis === "measured" ? (
        <Badge tone="accent">{fill(t.community.measuredDays, { days: s.result.days })}</Badge>
      ) : (
        <span className="inline-flex items-center whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted">
          {t.community.expected}
        </span>
      )}
      {s.publicDataset ? <Badge>{t.community.publicDataset}</Badge> : null}
      {s.result.simulated ? <Badge>{t.community.simulated}</Badge> : null}
    </div>
  );
}

/** One side of a comparison: the avoidable share now, and how far the strategy takes it down. */
function Bar({
  label,
  before,
  after,
  scale,
  locale,
  none,
}: {
  label: string;
  before: number;
  after: number | null;
  scale: number;
  locale: Locale;
  none: string;
}) {
  const width = (share: number) => `${Math.min(100, (share / scale) * 100)}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{label}</span>
        <span className="num shrink-0 text-muted">
          {pct(before, locale, 1)} → {after === null ? none : pct(after, locale, 1)}
        </span>
      </div>
      <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-surface">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-waste/40"
          style={{ width: width(before) }}
        />
        {after === null ? null : (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: width(after) }}
          />
        )}
      </div>
    </div>
  );
}

/** What it takes to publish an option: a name to appear under, and what the others will and will not see. */
export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const qc = useQueryClient();
  const [alias, setAlias] = useState("");
  const [tried, setTried] = useState(false);
  const tooShort = tried && alias.trim().length < 2;
  const publish = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/community/strategies", {
          params: { path: { orgId, buildingId } },
          body: { option: target.option, turnId: target.turnId, alias: alias.trim(), locale },
        }),
      ),
    onSuccess: () => {
      feel("confirm");
      qc.invalidateQueries({ queryKey: ["community"] });
      toast(t.community.shared);
      onClose();
    },
    onError: () => feel("reject"),
  });
  return (
    <Dialog
      title={t.community.shareTitle}
      confirm={t.community.shareConfirm}
      busy={publish.isPending}
      onConfirm={() => {
        setTried(true);
        if (alias.trim().length >= 2) publish.mutate();
      }}
      onClose={onClose}
    >
      <p>{t.community.shareHint}</p>
      <div className="mt-3 text-text">
        <Field label={t.community.alias} hint={tooShort ? t.community.aliasHint : undefined}>
          <Input
            value={alias}
            maxLength={60}
            autoComplete="off"
            className="min-h-11"
            onChange={(e) => setAlias(e.target.value)}
          />
        </Field>
      </div>
      {publish.error ? (
        <div className="mt-3">
          <ErrorBox error={publish.error} />
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Strategies buildings share with each other, reused like skills. "Use this" plans one on this building's own data and
 * the result arrives as a turn in the chat, to preview or apply there; someone who may not ask previews it instead,
 * which leaves nothing behind. Figures say what they rest on: expected or measured, and from a public dataset or a
 * simulated building where they are. What a building shares is only ever the mix and the result.
 */
export function CommunityRail({
  onShare,
  onPreview,
}: {
  onShare: (target: ShareTarget) => void;
  onPreview: (view: SplitView) => void;
}) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const reviewer = can.reviewFindings(role);
  const asker = can.explain(role);
  const [sort, setSort] = useState<"recent" | "used">("recent");
  const [everything, setEverything] = useState(false);
  const [comparing, setComparing] = useState<string | null>(null);
  const turns = useTurns();
  const board = useStrategyBoard();
  const list = useQuery({
    queryKey: ["community", orgId, buildingId, sort, locale],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/community/strategies", {
          params: { path: { orgId }, query: { sort, limit: 20, locale, buildingId } },
        }),
      ),
  });
  const use = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/community/strategies/{id}/use", {
          params: { path: { orgId, buildingId, id } },
          body: { locale },
        }),
      ),
    onSuccess: () => {
      feel("confirm");
      qc.invalidateQueries({ queryKey: ["assistant-turns", orgId, buildingId] });
    },
    onError: () => feel("reject"),
  });
  const preview = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/community/strategies/{id}/plan", {
          params: { path: { orgId, buildingId, id } },
        }),
      ),
    onSuccess: ({ plan }) => {
      const option = plan.options[0];
      if (option) onPreview({ turnId: null, plan, optionId: option.id });
      else toast(t.assistant.nothingOpen);
    },
    onError: () => feel("reject"),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/buildings/{buildingId}/community/strategies/{id}", {
          params: { path: { orgId, buildingId, id } },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["community"] });
      toast(t.community.withdrawn);
    },
    onError: () => feel("reject"),
  });

  const items = list.data?.items ?? [];
  const shown = everything ? items : items.slice(0, SHOWN);
  // the latest option applied here that this building is not already sharing
  const applied = turns.data?.items.findLast((x) => x.appliedOption);
  const sharable =
    reviewer &&
    applied?.appliedOption &&
    list.data &&
    !items.some((s) => s.mine && s.optionKind === kindOf(applied.appliedOption!))
      ? { turnId: applied.id, option: applied.appliedOption }
      : null;
  const plan = board.data?.plan;
  const error = use.error ?? preview.error ?? withdraw.error;

  return (
    <Card
      title={t.community.title}
      actions={
        <div className="flex shrink-0 gap-0.5">
          {(["recent", "used"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              onClick={() => {
                tick();
                setSort(key);
              }}
              className={
                sort === key
                  ? "fc-press min-h-11 rounded-full bg-accent-soft px-2.5 text-xs font-medium text-accent sm:min-h-8"
                  : "fc-press min-h-11 rounded-full px-2.5 text-xs font-medium text-muted hover:text-text sm:min-h-8"
              }
            >
              {t.community[key]}
            </button>
          ))}
        </div>
      }
    >
      <p className="text-xs text-muted">{t.community.hint}</p>

      {sharable ? (
        <div className="mt-3 rounded-2xl bg-accent-soft p-3">
          <p className="text-sm">
            {fill(t.community.sharePrompt, {
              title: t.assistant.options[sharable.option] ?? sharable.option,
            })}
          </p>
          <Button variant="primary" className="mt-2 min-h-11 sm:min-h-9" onClick={() => onShare(sharable)}>
            {t.community.share}
          </Button>
        </div>
      ) : null}

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <div className="mt-3">
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-border p-4 text-center">
          <p className="text-sm text-muted">{t.community.empty}</p>
          {asker ? (
            <Button
              className="mt-3 min-h-11 sm:min-h-9"
              onClick={() => {
                const input = document.getElementById("assistant-input");
                input?.scrollIntoView({ block: "center" });
                input?.focus();
              }}
            >
              {t.community.ask}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((s) => {
            const open = comparing === s.id;
            const mine = plan?.options.find((o) => kindOf(o.id) === s.optionKind);
            const scale = Math.max(0.01, plan?.before.avoidableShare ?? 0, s.result.avoidableShareBefore);
            return (
              <li key={s.id} className="rounded-2xl bg-surface-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-muted">{s.alias}</p>
                    <p className="text-sm font-medium break-words">{s.title}</p>
                  </div>
                  <Basis s={s} />
                </div>
                <p className="num mt-1 text-xs">
                  {fill(t.community.shareLine, {
                    before: pct(s.result.avoidableShareBefore, locale, 1),
                    after: pct(s.result.avoidableShareAfter, locale, 1),
                  })}
                </p>
                <p className="num text-xs text-muted">
                  {[
                    fill(t.community.floors, { n: s.floorsCount }),
                    fill(t.community.area, { band: s.areaBand }),
                    fill(t.community.uses, { n: s.uses }),
                  ].join(" · ")}
                </p>
                {open ? (
                  <div className="fc-rise mt-2 space-y-2">
                    {plan && !plan.window.days ? (
                      <p className="text-xs text-muted">{t.community.noData}</p>
                    ) : plan ? (
                      <Bar
                        label={fill(t.community.barExpected, { who: t.community.mine })}
                        before={plan.before.avoidableShare}
                        after={mine?.after.avoidableShare ?? null}
                        scale={scale}
                        locale={locale}
                        none={t.community.noOption}
                      />
                    ) : null}
                    <Bar
                      label={fill(
                        s.result.basis === "measured" ? t.community.barMeasured : t.community.barExpected,
                        { who: s.alias },
                      )}
                      before={s.result.avoidableShareBefore}
                      after={s.result.avoidableShareAfter}
                      scale={scale}
                      locale={locale}
                      none="–"
                    />
                    <p className="text-xs text-muted">{s.summary}</p>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {s.mine ? (
                    <>
                      <Badge tone="accent">{t.community.yours}</Badge>
                      {reviewer ? (
                        <Button
                          variant="ghost"
                          className="min-h-11 sm:min-h-9"
                          busy={withdraw.isPending && withdraw.variables === s.id}
                          onClick={() => withdraw.mutate(s.id)}
                        >
                          {t.community.withdraw}
                        </Button>
                      ) : null}
                    </>
                  ) : asker ? (
                    <Button
                      variant="primary"
                      className="min-h-11 flex-1 sm:min-h-9"
                      busy={use.isPending && use.variables === s.id}
                      onClick={() => use.mutate(s.id)}
                    >
                      {t.community.use}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      className="min-h-11 flex-1 sm:min-h-9"
                      busy={preview.isPending && preview.variables === s.id}
                      onClick={() => preview.mutate(s.id)}
                    >
                      {t.assistant.preview}
                    </Button>
                  )}
                  <Button
                    aria-expanded={open}
                    className="min-h-11 flex-1 sm:min-h-9"
                    onClick={() => {
                      tick();
                      setComparing(open ? null : s.id);
                    }}
                  >
                    {open ? t.community.hide : t.community.compare}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!everything && items.length > SHOWN ? (
        <button
          type="button"
          onClick={() => setEverything(true)}
          className="mt-3 min-h-11 text-sm font-medium text-accent sm:min-h-0"
        >
          {fill(t.community.showAll, { n: items.length })}
        </button>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
      {asker ? null : <p className="mt-3 text-xs text-muted">{t.community.cannotUse}</p>}
      {reviewer ? null : <p className="mt-3 text-xs text-muted">{t.community.cannotShare}</p>}
    </Card>
  );
}
