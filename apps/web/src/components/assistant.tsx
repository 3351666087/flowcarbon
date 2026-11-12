"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, SendHorizontal, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { POLL_MS, useTypewriter } from "@/components/ai-explanation";
import { useAuthMethods } from "@/components/auth-code";
import { useOwnDemo } from "@/components/demo-banner";
import { feel } from "@/components/glass";
import { toast } from "@/components/toast";
import { Badge, Button, Card, ErrorBox, errorText, Input } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import type { AssistantTurn, TurnOption, TurnPlan } from "@/lib/api-shapes";
import { dateTime, kwh, pct, prettyNumbers } from "@/lib/format";
import { type Dict, fill, useI18n } from "@/lib/i18n";
import { parsePartialJson } from "@/lib/partial-json";
import { can, useBuilding, useFloors, useIds, useMembership } from "@/lib/session";

/** How many exchanges show before "show earlier". */
const SHOWN = 3;
/** Past the longest the API lets a turn stay pending, so it gets the chance to say the turn has failed. */
const POLL_LIMIT_MS = 21 * 60_000;

/** An option on screen in the before/after split, among the others of the plan it came from. */
export interface SplitView {
  /** null for a preview that no turn stands behind: from the strategy board, or a shared strategy */
  turnId: string | null;
  plan: TurnPlan;
  optionId: TurnOption["id"];
}

/** An applied option that can be shared with other buildings. */
export interface ShareTarget {
  turnId: string;
  option: TurnOption["id"];
}

/** Motion follows the system setting; a scroll is not covered by the stylesheet's reduced-motion rule. */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const glide = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");

/** The building's turns, every finished one in the language of the page. */
export function useTurns() {
  const { locale } = useI18n();
  const { orgId, buildingId } = useIds();
  return useQuery({
    queryKey: ["assistant-turns", orgId, buildingId, locale],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant/turns", {
          params: { path: { orgId, buildingId }, query: { limit: 20, locale } },
        }),
      ),
  });
}

export function useStrategyBoard(enabled = true) {
  const { orgId, buildingId } = useIds();
  return useQuery({
    queryKey: ["strategy-board", orgId, buildingId],
    enabled,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/strategy-board", {
          params: { path: { orgId, buildingId } },
        }),
      ),
  });
}

/** Where a set of measures stands right now. */
export function standing(measures: readonly { status: string }[]) {
  return {
    now: measures.filter((m) => m.status === "in_effect").length,
    planned: measures.filter((m) => m.status === "planned").length,
  };
}

/** The same in a sentence, which only says "in effect" of what is. */
export function statusLine(measures: readonly { status: string }[], t: Dict) {
  const { now, planned } = standing(measures);
  if (now && planned) return fill(t.split.mixed, { now, planned });
  return now ? t.split.inEffect : t.split.planned;
}

/** How many of an applied option's actions found anything left to do. */
export function appliedOf(turn: AssistantTurn) {
  const option = turn.plan?.options.find((o) => o.id === turn.appliedOption);
  const n = (turn.appliedMeasures ?? []).filter((m) => m.status !== "cancelled").length;
  return { n, total: option?.actions.length ?? n };
}

/**
 * Applying an option, adopting one straight from the strategy board, and taking either back. All of them move measures
 * and findings, so everything built on those refreshes. Adopting and undoing stay busy until the refresh is in: a card
 * must not offer the same action again while it is about to turn over.
 */
export function useTurnActions() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all(
      ["assistant-turns", "strategy-board", "community", "measures", "findings", "overview", "brief"].map(
        (key) => qc.invalidateQueries({ queryKey: [key] }),
      ),
    );
  const undo = useMutation({
    mutationFn: (turnId: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant/turns/{turnId}/undo", {
          params: { path: { orgId, buildingId, turnId } },
        }),
      ),
    onSuccess: async () => {
      toast(t.assistant.undone);
      await refresh();
    },
    onError: (err) => {
      feel("reject");
      toast(errorText(err, t));
    },
  });
  const announce = (turn: AssistantTurn, done: { now: string; planned: string; mixed: string }) => {
    feel("confirm");
    const { now, planned } = standing(turn.appliedMeasures ?? []);
    const { n, total } = appliedOf(turn);
    const said =
      n < total
        ? fill(t.assistant.appliedSome, { n, total })
        : now && planned
          ? fill(done.mixed, { now, planned })
          : fill(now ? done.now : done.planned, { n });
    toast(said, { label: t.plan.undo, run: () => undo.mutate(turn.id) });
  };
  const apply = useMutation({
    mutationFn: ({ turnId, option }: ShareTarget) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant/turns/{turnId}/apply", {
          params: { path: { orgId, buildingId, turnId } },
          body: { option },
        }),
      ),
    onSuccess: (turn) => {
      refresh();
      announce(turn, {
        now: t.assistant.appliedNow,
        planned: t.assistant.appliedPlanned,
        mixed: t.assistant.appliedMixed,
      });
    },
    onError: () => feel("reject"),
  });
  const adopt = useMutation({
    mutationFn: (option: Exclude<TurnOption["id"], "community">) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/strategy-board/adopt", {
          params: { path: { orgId, buildingId } },
          body: { option, locale },
        }),
      ),
    onSuccess: async (turn) => {
      announce(turn, {
        now: t.strategies.adoptedNow,
        planned: t.strategies.adoptedPlanned,
        mixed: t.strategies.adoptedMixed,
      });
      await refresh();
    },
    onError: () => feel("reject"),
  });
  return { apply, adopt, undo };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** a figure and its unit stay together when a narrow card wraps the line */
export const whole = (figure: string) => figure.replace(/ /g, "\u00a0");

/** What the assistant has said so far: the finished reply, or as much of the streamed draft as has arrived. */
function saidIn(turn: AssistantTurn) {
  const raw = turn.reply ?? (turn.draft ? parsePartialJson(turn.draft) : null);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const options = new Map<string, { title: string; why: string }>();
  for (const x of Array.isArray(o.options) ? o.options : []) {
    if (x && typeof x === "object") {
      const { id, title, why } = x as Record<string, unknown>;
      options.set(str(id), { title: str(title), why: str(why) });
    }
  }
  return { reply: str(o.reply), options };
}

/** What an option is expected to do. The figures are the planner's, never the model's. */
export function OptionFigures({ plan, option }: { plan: TurnPlan; option: TurnOption }) {
  const { t, locale } = useI18n();
  const saved = (m: TurnOption["after"]) => plan.before.kwh - m.kwh;
  return (
    <>
      <span className="num mt-2 block text-lg font-semibold tracking-tight text-saving">
        {kwh(saved(option.after), locale)}
      </span>
      <span className="block text-xs text-muted">{fill(t.assistant.saving, { days: plan.window.days })}</span>
      <span className="num mt-1 block text-xs">
        {fill(t.assistant.shareLine, {
          before: whole(pct(plan.before.avoidableShare, locale, 1)),
          after: whole(pct(option.after.avoidableShare, locale, 1)),
        })}
      </span>
      <span className="num block text-xs text-muted">
        {fill(t.assistant.range, {
          low: whole(kwh(saved(option.low), locale)),
          high: whole(kwh(saved(option.high), locale)),
        })}
      </span>
      <span className="num mt-1 block text-[11px] text-muted">
        {fill(t.assistant.assumes, {
          mid: whole(pct(plan.realisation.mid, locale)),
          low: whole(pct(plan.realisation.low, locale)),
          high: whole(pct(plan.realisation.high, locale)),
        })}
      </span>
    </>
  );
}

/** One option: what it is expected to save and what is done with it. */
function OptionCard({
  turn,
  plan,
  option,
  title,
  why,
  ready,
  reviewer,
  actions,
  onOpen,
  onShare,
}: {
  turn: AssistantTurn | null;
  plan: TurnPlan;
  option: TurnOption;
  title: string;
  why?: ReactNode;
  /** finished writing, so it can be acted on */
  ready: boolean;
  reviewer: boolean;
  actions: ReturnType<typeof useTurnActions>;
  onOpen: () => void;
  onShare: (target: ShareTarget) => void;
}) {
  const { t, locale } = useI18n();
  const { apply, undo } = actions;
  const applied = turn?.appliedOption === option.id;
  const taken = !!turn?.appliedOption && !applied;
  const count = applied && turn ? appliedOf(turn) : null;
  const partly = count && count.n < count.total ? count : null;
  return (
    <li
      id={`option-${turn?.id ?? "board"}-${option.id}`}
      className="flex flex-col rounded-2xl bg-surface-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {applied ? (
          <Badge tone="saving">
            <Check className="size-3" aria-hidden /> {t.assistant.applied}
          </Badge>
        ) : option.reachesTarget ? (
          <Badge tone="saving">{option.reachesAtLow ? t.assistant.reaches : t.assistant.reachesMid}</Badge>
        ) : option.shortBy !== null ? (
          <Badge tone="waste">{fill(t.assistant.short, { pct: pct(option.shortBy, locale, 1) })}</Badge>
        ) : null}
      </div>
      {why ? <p className="mt-1 text-sm">{why}</p> : null}
      <OptionFigures plan={plan} option={option} />
      {!applied && option.reachesTarget && !option.reachesAtLow ? (
        <p className="mt-1 text-xs text-muted">{t.assistant.reachesLow}</p>
      ) : null}
      {partly ? <p className="mt-1 text-xs text-muted">{fill(t.assistant.appliedSome, partly)}</p> : null}
      {ready ? (
        <div className="mt-auto flex flex-wrap gap-2 pt-3">
          <Button className="min-h-11 flex-1 sm:min-h-9" onClick={onOpen}>
            {t.assistant.preview}
          </Button>
          {turn && reviewer && applied ? (
            <>
              <Button
                className="min-h-11 flex-1 sm:min-h-9"
                busy={undo.isPending && undo.variables === turn.id}
                onClick={() => undo.mutate(turn.id)}
              >
                {t.plan.undo}
              </Button>
              <Button
                variant="ghost"
                className="min-h-11 w-full text-accent sm:min-h-9"
                onClick={() => onShare({ turnId: turn.id, option: option.id })}
              >
                {t.community.share}
              </Button>
            </>
          ) : turn && reviewer ? (
            <Button
              variant="primary"
              className="min-h-11 flex-1 sm:min-h-9"
              disabled={taken}
              title={taken ? t.assistant.oneAtATime : undefined}
              busy={
                apply.isPending && apply.variables?.turnId === turn.id && apply.variables.option === option.id
              }
              onClick={() => apply.mutate({ turnId: turn.id, option: option.id }, { onSuccess: onOpen })}
            >
              {t.assistant.apply}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One exchange: what was asked, the reply as it is written, and the options under it. */
function Turn({
  turn: listed,
  reviewer,
  actions,
  onOpen,
  onShare,
}: {
  turn: AssistantTurn;
  reviewer: boolean;
  actions: ReturnType<typeof useTurnActions>;
  onOpen: (view: SplitView) => void;
  onShare: (target: ShareTarget) => void;
}) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const qc = useQueryClient();
  const pending = listed.status === "pending";
  const live = useQuery({
    queryKey: ["assistant-turn", listed.id, locale],
    enabled: pending,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant/turns/{turnId}", {
          params: { path: { orgId, buildingId, turnId: listed.id }, query: { locale } },
        }),
      ),
    refetchInterval: (q) => {
      if (q.state.data && q.state.data.status !== "pending") return false;
      return Date.now() - Date.parse(listed.createdAt) < POLL_LIMIT_MS ? POLL_MS : false;
    },
  });
  const settled = live.data && live.data.status !== "pending";
  useEffect(() => {
    if (settled) qc.invalidateQueries({ queryKey: ["assistant-turns", orgId, buildingId] });
  }, [settled, qc, orgId, buildingId]);
  const turn = pending && live.data ? live.data : listed;

  // only a reply seen being written is typed out
  const watched = useRef(false);
  if (turn.status === "pending") watched.current = true;
  const streams = watched.current && turn.status !== "failed";
  // words being written in the language the page has just left stay off screen until the turn is told in this one
  const foreign = turn.status === "pending" && turn.locale !== locale;
  const said = useMemo(() => (foreign ? saidIn({ ...turn, draft: null }) : saidIn(turn)), [turn, foreign]);
  const plan = turn.plan;
  const options = plan?.options ?? [];
  // figures in the words read like the cards beside them (181.3 MWh, not 181288 kWh); what was stored is untouched
  const currency = building?.currency ?? "CNY";
  const segments = [
    { key: "reply", text: prettyNumbers(said.reply, locale, currency) },
    ...options.map((o) => ({
      key: o.id,
      text: prettyNumbers(said.options.get(o.id)?.why ?? "", locale, currency),
    })),
  ];
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  const done = turn.status === "done";
  const shown = useTypewriter(total, streams, done, turn.locale === "zh" ? "zh" : "en");

  const visible = new Map<string, string>();
  let left = shown;
  let caret: string | null = null;
  for (const s of segments) {
    const n = Math.max(0, Math.min(s.text.length, left));
    visible.set(s.key, s.text.slice(0, n));
    if (n > 0) caret = s.key;
    left -= s.text.length;
  }
  const writing = turn.status === "pending" || shown < total;
  const text = (key: string): ReactNode =>
    visible.get(key) ? (
      <>
        {visible.get(key)}
        {writing && caret === key ? <span className="fc-stream-caret" aria-hidden /> : null}
      </>
    ) : null;

  const titleOf = (id: TurnOption["id"]) => said.options.get(id)?.title || t.assistant.options[id] || id;
  const open = (optionId: TurnOption["id"]) => plan && onOpen({ turnId: turn.id, plan, optionId });

  return (
    <div id={`turn-${listed.id}`} className="scroll-mt-[calc(var(--app-top)+72px)]">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-sm break-words">
          {turn.prompt}
        </p>
      </div>
      <div className="mt-2 space-y-2.5" aria-busy={writing}>
        {turn.status === "failed" ? (
          <p className="text-sm text-danger">{t.assistant.failed}</p>
        ) : !visible.get("reply") && !options.length ? (
          <Waiting />
        ) : (
          <>
            {visible.get("reply") ? (
              <p className={streams ? "fc-stream-in text-sm" : "text-sm"}>{text("reply")}</p>
            ) : (
              <Waiting />
            )}
            {options.length ? (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                {options.map((o) => (
                  <OptionCard
                    key={o.id}
                    turn={turn}
                    plan={plan!}
                    option={o}
                    title={titleOf(o.id)}
                    why={text(o.id)}
                    ready={done && !writing}
                    reviewer={reviewer}
                    actions={actions}
                    onOpen={() => open(o.id)}
                    onShare={onShare}
                  />
                ))}
              </ul>
            ) : null}
            {done && !writing ? (
              <p className="text-[11px] text-muted">
                {[
                  turn.requestedBy,
                  dateTime(turn.completedAt, locale, building?.timezone ?? "Asia/Shanghai"),
                  turn.model ? fill(t.assistant.writtenBy, { model: turn.model }) : t.assistant.template,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </>
        )}
        {done && !writing && options.length ? (
          !reviewer ? (
            <p className="text-xs text-muted">{t.assistant.previewOnly}</p>
          ) : turn.appliedOption && options.length > 1 ? (
            <p className="text-xs text-muted">{t.assistant.oneAtATime}</p>
          ) : null
        ) : null}
        {done && !writing && options.length && plan && plan.adoptedKwh > 0 ? (
          <p className="num text-xs text-muted">
            {fill(t.assistant.fromAdopted, {
              recorded: whole(pct(plan.recorded.avoidableShare, locale, 1)),
              adopted: whole(pct(plan.before.avoidableShare, locale, 1)),
            })}
          </p>
        ) : null}
        {done && !writing && turn.outdated && options.length ? (
          <p className="text-xs text-muted">{t.assistant.outdated}</p>
        ) : null}
      </div>
    </div>
  );
}

function Waiting() {
  const { t } = useI18n();
  return (
    <div className="space-y-2.5" aria-busy>
      <p className="inline-flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 animate-pulse text-accent" aria-hidden />
        <span className="fc-stream-wait">{t.assistant.reading}</span>
      </p>
      <div className="fc-skel h-3 w-11/12" />
      <div className="fc-skel h-3 w-4/5" />
    </div>
  );
}

/** Says why someone cannot do all of this, rather than leaving them to wonder where the buttons went. */
export function Limits({ asker, reviewer }: { asker: boolean; reviewer: boolean }) {
  const { t } = useI18n();
  const methods = useAuthMethods();
  const membership = useMembership();
  const own = useOwnDemo();
  if (asker && reviewer) return null;
  const shared = !!methods.data?.demo && membership?.orgSlug === methods.data.demo.slug;
  // someone who can ask is told what is left of their role: the shared demo is read-only only for those who cannot
  if (shared && !asker)
    return (
      <div className="mt-3 space-y-3 rounded-2xl bg-surface-2 p-3">
        <p className="text-sm">{t.assistant.demoNote}</p>
        <Button variant="primary" className="min-h-11 sm:min-h-9" busy={own.busy} onClick={own.start}>
          {t.plan.getDemo}
        </Button>
      </div>
    );
  const role = membership?.role;
  return (
    <p className="mt-3 rounded-2xl bg-surface-2 p-3 text-sm text-muted">
      {fill(asker ? t.assistant.roleNoApply : t.assistant.roleNoAsk, {
        role: role ? (t.settings.roles[role] ?? role) : "–",
      })}
    </p>
  );
}

/**
 * The chat box of the first page: ask for a target or give a plain command, and options come back under the reply. The
 * planner computes every figure from the building's data and a model only writes the words around them, so with no
 * model the same plan arrives with templated words. `onOpen` asks for the before/after split, `onShare` to share what
 * was applied. Someone who may not ask still sees what the data suggests, from the strategy board, and can preview it.
 */
export function Assistant({
  noData = false,
  onOpen,
  onShare,
}: {
  /** the building has no data, so every suggestion would come back empty */
  noData?: boolean;
  onOpen: (view: SplitView) => void;
  onShare: (target: ShareTarget) => void;
}) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const role = useMembership()?.role;
  const qc = useQueryClient();
  const asker = can.explain(role);
  const reviewer = can.reviewFindings(role);
  const turns = useTurns();
  const board = useStrategyBoard();
  const floors = useFloors();
  const actions = useTurnActions();
  const [prompt, setPrompt] = useState("");
  const [everything, setEverything] = useState(false);

  const send = useMutation({
    mutationFn: async (text: string) => {
      await unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant", {
          params: { path: { orgId, buildingId } },
          body: { prompt: text, locale },
        }),
      );
      await qc.invalidateQueries({ queryKey: ["assistant-turns", orgId, buildingId] });
    },
    onError: (_err, text) => {
      feel("reject");
      setPrompt(text);
    },
  });
  const ask = (text: string) => {
    const clean = text.trim();
    if (!clean || send.isPending) return;
    feel("press");
    setPrompt("");
    send.mutate(clean);
  };

  // a new exchange comes into view, whether it was typed here or started from the community rail. What is adopted on
  // the strategies page has a turn too, but nobody said it here, and undoing it there would leave it claiming otherwise
  const items = (turns.data?.items ?? []).filter((x) => x.intent?.source !== "board");
  const newest = turns.data ? (items.at(-1)?.id ?? null) : undefined;
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (newest === undefined) return;
    if (seen.current !== undefined && newest && newest !== seen.current)
      document.getElementById(`turn-${newest}`)?.scrollIntoView({ behavior: glide(), block: "start" });
    seen.current = newest;
  }, [newest]);

  const hidden = everything ? 0 : Math.max(0, items.length - SHOWN);
  const options = board.data?.plan.options ?? [];
  // a command the building can do something with: the page's own suggestion must not lead nowhere
  const open = options.flatMap((o) => o.actions);
  const lights = open.find((a) => a.strategyId === "auto_lights_off");
  const floorOf = (id?: string) => floors.data?.find((f) => f.id === id)?.label;
  const command = lights ? floorOf(lights.floorId) : floorOf(open[0]?.floorId);
  const chips = noData
    ? []
    : [
        t.assistant.chipTarget,
        ...(command
          ? [fill(lights ? t.assistant.chipCommand : t.assistant.chipCommandCooling, { floor: command })]
          : board.data
            ? []
            : [t.assistant.chipCommandAny]),
        t.assistant.chipWeekend,
      ];

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden /> {t.assistant.title}
        </span>
      }
    >
      <p className="text-xs text-muted">{t.assistant.hint}</p>
      <Limits asker={asker} reviewer={reviewer} />

      {turns.error ? (
        <div className="mt-3">
          <ErrorBox error={turns.error} onRetry={() => turns.refetch()} />
        </div>
      ) : null}
      {hidden ? (
        <button
          type="button"
          onClick={() => setEverything(true)}
          className="mt-3 min-h-11 text-sm font-medium text-accent sm:min-h-0"
        >
          {fill(t.assistant.earlier, { n: hidden })}
        </button>
      ) : null}
      {items.length || send.isPending ? (
        <div className="mt-4 space-y-5">
          {items.slice(hidden).map((turn) => (
            <Turn
              key={turn.id}
              turn={turn}
              reviewer={reviewer}
              actions={actions}
              onOpen={onOpen}
              onShare={onShare}
            />
          ))}
          {send.isPending ? (
            <div>
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-sm break-words">
                  {send.variables}
                </p>
              </div>
              <div className="mt-2">
                <Waiting />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!asker && board.data ? (
        <section className="mt-4">
          <h3 className="text-xs font-semibold text-muted">{t.assistant.fromData}</h3>
          {options.length ? (
            <>
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                {options.map((o) => (
                  <OptionCard
                    key={o.id}
                    turn={null}
                    plan={board.data.plan}
                    option={o}
                    title={t.assistant.options[o.id] ?? o.id}
                    ready
                    reviewer={false}
                    actions={actions}
                    onOpen={() => onOpen({ turnId: null, plan: board.data.plan, optionId: o.id })}
                    onShare={onShare}
                  />
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">{t.assistant.previewOnly}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">{t.assistant.nothingOpen}</p>
          )}
        </section>
      ) : null}

      {actions.apply.error ? (
        <div className="mt-3">
          <ErrorBox error={actions.apply.error} />
        </div>
      ) : null}
      {send.error ? (
        <div className="mt-3">
          <ErrorBox error={send.error} />
        </div>
      ) : null}

      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(prompt);
        }}
      >
        <Input
          id="assistant-input"
          aria-label={t.assistant.placeholder}
          placeholder={t.assistant.placeholder}
          value={prompt}
          maxLength={500}
          disabled={!asker}
          autoComplete="off"
          enterKeyHint="send"
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-11 flex-1 rounded-full px-4"
        />
        <Button
          type="submit"
          variant="primary"
          aria-label={t.assistant.send}
          busy={send.isPending}
          disabled={!asker || !prompt.trim()}
          className="min-h-11 shrink-0"
        >
          {send.isPending ? null : <SendHorizontal className="size-4" aria-hidden />}
        </Button>
      </form>
      {asker ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={send.isPending}
              onClick={() => ask(chip)}
              className="fc-press min-h-11 rounded-full border border-border px-3 text-left text-sm text-muted hover:text-text disabled:opacity-50 sm:min-h-9"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
