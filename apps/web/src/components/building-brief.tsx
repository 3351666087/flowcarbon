"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { POLL_MS, useTypewriter } from "@/components/ai-explanation";
import { glide, useStrategyBoard } from "@/components/assistant";
import { strategyName } from "@/components/finding-plan";
import { feel, tick } from "@/components/glass";
import type { ComparedPriority } from "@/components/strategy-compare";
import { toast } from "@/components/toast";
import { Badge, Button, Card, ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { dateTime, kwh, type Locale, money, prettyNumbers } from "@/lib/format";
import { type Dict, fill, useI18n } from "@/lib/i18n";
import { parsePartialJson } from "@/lib/partial-json";
import { can, useBuilding, useIds, useMembership } from "@/lib/session";

interface Priority {
  floor: string;
  ruleId: string;
  strategyId: string;
  why: string;
  // filled in when the brief is finished
  floorId?: string;
  findings?: number;
  avoidableKwh?: number;
  avoidableCost?: number;
  findingId?: string;
  /** the measure its finding has gone into since, however that came about: adopting it again would be refused */
  measureId?: string;
}
interface Brief {
  headline: string;
  priorities: Priority[];
  watch: string[];
}

/** A brief asked for without a tap, because this language had none: once per building and language in a session. */
const askedFor = new Set<string>();

const str = (v: unknown) => (typeof v === "string" ? v : "");

function briefOf(output: unknown, draft: string | null): Brief | null {
  const raw = output ?? (draft ? parsePartialJson(draft) : null);
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    headline: str(o.headline),
    priorities: (Array.isArray(o.priorities) ? o.priorities : []).flatMap((p) =>
      p && typeof p === "object" ? [p as Priority] : [],
    ),
    watch: Array.isArray(o.watch) ? o.watch.filter((x): x is string => typeof x === "string") : [],
  };
}

/**
 * The model is told to name strategies in words, but an id that slips into the text is shown by its name, and figures
 * read like the cards beside them. For display only.
 */
function polish(text: string, t: Dict, locale: Locale, currency: string) {
  let out = text;
  for (const id of Object.keys(t.domain.strategies))
    if (out.includes(id)) out = out.replace(new RegExp(`\\b${id}\\b`, "g"), strategyName(t, id));
  return prettyNumbers(out, locale, currency);
}

interface OverviewProps {
  onShow: (floorId: string, ruleId: string) => void;
  /** the priority on show in the comparison */
  compared: ComparedPriority | null;
  onCompare: (priority: ComparedPriority) => void;
}

/**
 * The AI assistant's look at the whole building, beside the comparison of strategies: which groups to act on first and
 * with what, so nobody has to open findings one by one to find out. Each priority can be compared before and after
 * (the figures come from the plan, not from the model), adopted as it stands (a measure for that floor, taking in its
 * open findings of that kind), adopted after editing, or opened.
 *
 * A brief is written in one language and shown only in that one. Each language starts from nothing, so text in the
 * old language never stays on screen: its own brief if there is one, otherwise it is asked for once (when the viewer
 * may ask), and a viewer who cannot ask is told so.
 */
export function BuildingBrief(props: OverviewProps) {
  const { locale } = useI18n();
  return <Overview key={locale} {...props} />;
}

function Overview({ onShow, compared, onCompare }: OverviewProps) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const role = useMembership()?.role;
  const asker = can.explain(role);
  const reviewer = can.reviewFindings(role);
  const qc = useQueryClient();
  const path = { orgId, buildingId };

  const latest = useQuery({
    queryKey: ["brief", orgId, buildingId, locale],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/briefs/latest", {
          params: { path, query: { locale } },
        }),
      ),
  });
  // English has no names of its own for the rules: the API's are in English
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => unwrap(api.GET("/api/v1/rules")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const ruleName = (id: string) =>
    t.domain.ruleNames[id] ?? rules.data?.rules.find((r) => r.id === id)?.name ?? id;
  const pending = latest.data?.brief?.status === "pending" ? latest.data.brief : null;
  const live = useQuery({
    queryKey: ["brief-live", pending?.id],
    enabled: !!pending,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/briefs/{briefId}", {
          params: { path: { ...path, briefId: pending!.id } },
        }),
      ),
    refetchInterval: (q) => (!q.state.data || q.state.data.status === "pending" ? POLL_MS : false),
  });
  const settled = live.data && live.data.status !== "pending";
  useEffect(() => {
    if (settled) qc.invalidateQueries({ queryKey: ["brief", orgId, buildingId] });
  }, [settled, qc, orgId, buildingId]);
  const current = pending && live.data?.id === pending.id ? live.data : latest.data?.brief;

  const measures = useQuery({
    queryKey: ["measures", orgId, buildingId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures", { params: { path } })),
  });
  const adopted = (p: Priority) =>
    (measures.data?.items ?? []).find(
      (m) =>
        m.status !== "cancelled" &&
        (m.id === p.measureId || (m.floorId === p.floorId && m.strategyId === p.strategyId)),
    );
  // only what the plan has an action for can be compared: its figures are the planner's
  const board = useStrategyBoard();
  const actions = board.data?.plan.options.flatMap((o) => o.actions) ?? [];
  const action = (p: Priority) =>
    actions.find((a) => a.floorId === p.floorId && a.strategyId === p.strategyId);

  const refresh = () => {
    for (const key of ["measures", "findings", "strategy-board", "brief"])
      qc.invalidateQueries({ queryKey: [key] });
  };

  const request = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/briefs", {
          params: { path },
          body: { locale },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brief", orgId, buildingId] }),
  });
  const once = `${buildingId}|${locale}`;
  const missing = !!latest.data && !latest.data.brief && latest.data.otherLocale && asker;
  const { mutate: ask } = request;
  useEffect(() => {
    if (!missing || askedFor.has(once)) return;
    askedFor.add(once);
    ask();
  }, [missing, once, ask]);
  // from the moment it is known to be missing until the new brief is there to read
  const asking =
    !request.isError && (request.isPending || request.isSuccess || (missing && !askedFor.has(once)));
  const adopt = useMutation({
    mutationFn: (p: Priority) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}/measure", {
          params: { path: { ...path, findingId: p.findingId! } },
          body: { strategyId: p.strategyId, note: p.why, source: "ai", similar: true } as never,
        }),
      ),
    onSuccess: (r) => {
      feel("confirm");
      refresh();
      toast(
        r.joined
          ? fill(t.plan.joined, { floor: r.measure.floorLabel })
          : fill(t.plan.adopted, { n: r.linked }),
        {
          label: t.plan.undo,
          run: async () => {
            await unwrap(
              api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures/{measureId}", {
                params: { path: { ...path, measureId: r.measure.id } },
                body: { status: "cancelled" } as never,
              }),
            );
            refresh();
          },
        },
      );
    },
    onError: () => feel("reject"),
  });

  // only a brief seen being written is typed out
  const watched = useRef(new Set<string>());
  if (current?.status === "pending") watched.current.add(current.id);
  const streams = !!current && watched.current.has(current.id) && current.status !== "failed";
  const brief = useMemo(() => (current ? briefOf(current.output, current.draft) : null), [current]);
  const currency = building?.currency ?? "CNY";
  const segments = useMemo(
    () =>
      brief
        ? [
            { key: "headline", text: brief.headline },
            ...brief.priorities.map((p, i) => ({ key: `p-${i}`, text: str(p.why) })),
            ...brief.watch.map((w, i) => ({ key: `w-${i}`, text: w })),
          ].map((seg) => ({ ...seg, text: polish(seg.text, t, locale, currency) }))
        : [],
    [brief, t, locale, currency],
  );
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  const done = current?.status === "done";
  const shown = useTypewriter(total, streams, done, locale === "zh" ? "zh" : "en");

  const visible = new Map<string, string>();
  let left = shown;
  let caret: string | null = null;
  for (const s of segments) {
    const n = Math.max(0, Math.min(s.text.length, left));
    visible.set(s.key, s.text.slice(0, n));
    if (n > 0) caret = s.key;
    left -= s.text.length;
  }
  const writing = current?.status === "pending" || shown < total;
  const text = (key: string): ReactNode => (
    <>
      {visible.get(key) ?? ""}
      {writing && caret === key ? <span className="fc-stream-caret" aria-hidden /> : null}
    </>
  );
  const base = `/o/${orgId}/b/${buildingId}`;
  const reading = (
    <div className="mt-4 space-y-2.5" aria-busy>
      <p className="inline-flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 animate-pulse text-accent" aria-hidden />
        <span className="fc-stream-wait">{t.brief.reading}</span>
      </p>
      <div className="fc-skel h-3 w-11/12" />
      <div className="fc-skel h-3 w-4/5" />
    </div>
  );

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden /> {t.brief.title}
        </span>
      }
    >
      <p className="text-xs text-muted">{t.brief.hint}</p>

      {latest.isPending ? (
        <div className="mt-4 space-y-2">
          <div className="fc-skel h-3 w-11/12" />
          <div className="fc-skel h-3 w-2/3" />
        </div>
      ) : !current ? (
        asking ? (
          reading
        ) : asker ? (
          <Button
            variant="primary"
            className="mt-4 min-h-11 sm:min-h-9"
            busy={request.isPending}
            onClick={() => request.mutate()}
          >
            <Sparkles className="size-4" aria-hidden /> {t.brief.request}
          </Button>
        ) : (
          <p className="mt-4 text-sm text-muted">
            {latest.data?.otherLocale ? t.brief.otherLanguage : t.brief.none}
          </p>
        )
      ) : current.status === "failed" ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-danger">{current.error}</p>
          {asker ? (
            <Button className="min-h-11 sm:min-h-9" busy={request.isPending} onClick={() => request.mutate()}>
              <RefreshCw className="size-4" aria-hidden /> {t.brief.again}
            </Button>
          ) : null}
        </div>
      ) : !brief || total === 0 ? (
        reading
      ) : (
        <div className="mt-3 space-y-3" aria-busy={writing}>
          {visible.get("headline") ? <p className="text-[15px] font-medium">{text("headline")}</p> : null}
          {brief.priorities.length ? (
            <ol className="space-y-2.5">
              {brief.priorities.map((p, i) => {
                const key = `p-${i}`;
                if (!visible.get(key)) return null;
                const has = adopted(p);
                const finished = done && !writing && !!p.findingId;
                const showing = compared?.floorId === p.floorId && compared?.strategyId === p.strategyId;
                return (
                  <li key={key} className={clsx("rounded-2xl bg-surface-2 p-3", streams && "fc-stream-in")}>
                    <div className="flex items-start gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-sm font-semibold">
                        {p.floor}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{ruleName(p.ruleId)}</div>
                        {p.findings ? (
                          <div className="num text-xs text-muted">
                            {fill(t.brief.size, {
                              n: p.findings,
                              kwh: kwh(p.avoidableKwh, locale),
                              cost: money(p.avoidableCost, locale, currency),
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone="accent">
                        <Sparkles className="size-3" aria-hidden /> {strategyName(t, p.strategyId)}
                      </Badge>
                      {has ? (
                        <Badge tone="saving">
                          <Check className="size-3" aria-hidden /> {t.plan.statuses[has.status]}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm">{text(key)}</p>
                    {has && has.strategyId !== p.strategyId ? (
                      <p className="mt-1 text-xs text-muted">
                        {fill(t.brief.taken, { strategy: strategyName(t, has.strategyId) })}
                      </p>
                    ) : null}
                    {finished ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {action(p) ? (
                          <Button
                            aria-pressed={showing}
                            className="min-h-11 px-3 sm:h-8 sm:min-h-0"
                            onClick={() => {
                              tick();
                              onCompare({
                                floorId: p.floorId!,
                                strategyId: p.strategyId,
                                title: `${p.floor} · ${strategyName(t, p.strategyId)}`,
                                coveredKwh: action(p)!.coveredKwh,
                              });
                              document
                                .getElementById("strategy-panel")
                                ?.scrollIntoView({ behavior: glide(), block: "start" });
                            }}
                          >
                            {showing ? t.brief.comparing : t.brief.compare}
                          </Button>
                        ) : null}
                        {reviewer && !has && p.strategyId !== "no_action" ? (
                          <>
                            <Button
                              variant="primary"
                              className="min-h-11 px-3 sm:h-8 sm:min-h-0"
                              busy={adopt.isPending && adopt.variables === p}
                              onClick={() => adopt.mutate(p)}
                            >
                              {t.plan.adopt}
                            </Button>
                            <Link
                              href={`${base}/findings/${p.findingId}?adopt=${p.strategyId}&why=${encodeURIComponent(p.why)}`}
                              className="fc-press inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-3 text-sm font-medium sm:h-8 sm:min-h-0"
                            >
                              {t.plan.adoptEdit}
                            </Link>
                          </>
                        ) : has ? (
                          <Link
                            href={`${base}/measures/${has.id}`}
                            className="inline-flex min-h-11 items-center text-sm font-medium text-accent sm:min-h-0"
                          >
                            {t.plan.details}
                          </Link>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => p.floorId && onShow(p.floorId, p.ruleId)}
                          className="ml-auto inline-flex min-h-11 items-center gap-0.5 text-sm font-medium text-muted hover:text-text sm:min-h-0"
                        >
                          {t.brief.show} <ChevronRight className="size-4" aria-hidden />
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {brief.watch.some((_, i) => visible.get(`w-${i}`)) ? (
            <section>
              <h3 className="text-xs font-semibold text-muted">{t.brief.watch}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted">
                {segments
                  .filter((seg) => seg.key.startsWith("w-") && visible.get(seg.key))
                  .map((seg) => (
                    <li key={seg.key}>{text(seg.key)}</li>
                  ))}
              </ul>
            </section>
          ) : null}
          {done && !writing ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-muted">
                {[
                  current.requestedBy,
                  dateTime(current.completedAt, locale, building?.timezone ?? "Asia/Shanghai"),
                  current.model
                    ? fill(t.assistant.writtenBy, { model: current.model })
                    : t.assistant.template,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {current.outdated ? <span className="text-xs text-muted">{t.brief.outdated}</span> : null}
                {asker ? (
                  <button
                    type="button"
                    disabled={request.isPending}
                    onClick={() => request.mutate()}
                    className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent disabled:opacity-50 sm:min-h-0"
                  >
                    <RefreshCw className="size-3.5" aria-hidden /> {t.brief.again}
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      )}
      {request.error ? (
        <div className="mt-3">
          <ErrorBox error={request.error} />
        </div>
      ) : null}
      {adopt.error ? (
        <div className="mt-3">
          <ErrorBox error={adopt.error} />
        </div>
      ) : null}
    </Card>
  );
}
