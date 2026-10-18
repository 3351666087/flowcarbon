"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { feel } from "@/components/glass";
import { api, unwrap } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { parsePartialJson } from "@/lib/partial-json";

export interface Explanation {
  id: string;
  status: "pending" | "done" | "failed";
  model: string | null;
  promptVersion: string;
  output: Record<string, unknown> | null;
  draft: string | null;
  error: string | null;
  completedAt: string | null;
}

/** what the reader sees, in the order it is written */
interface Answer {
  whatHappened: string;
  likelyCauses: string[];
  outlook: string;
  strategyId: string;
  reason: string;
  uncertainties: string[];
  basis: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** the finished output, or as much of the streamed draft as has arrived (reference ids only get titles at the end) */
function answerOf(e: Explanation): Answer | null {
  const done = e.status === "done";
  const raw = done ? e.output : e.draft ? parsePartialJson(e.draft) : null;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const action = (o.recommendedAction ?? {}) as Record<string, unknown>;
  return {
    whatHappened: str(o.whatHappened),
    likelyCauses: strings(o.likelyCauses),
    outlook: str(o.outlook),
    strategyId: str(action.strategyId),
    reason: str(action.reason),
    uncertainties: strings(o.uncertainties),
    basis: done && Array.isArray(o.basis) ? o.basis.map((b) => str((b as { title?: unknown }).title)) : [],
  };
}

/** characters per second at the least; the reveal speeds up to stay within LAG_S of what has arrived */
const BASE_RATE = { en: 70, zh: 32 } as const;
const LAG_S = 0.7;
/** a light tick every few characters of new text (a word, roughly), never closer than TICK_MS */
const TICK_CHARS = { en: 8, zh: 3 } as const;
const TICK_MS = 120;
/** how often the page asks for the text written so far */
const POLL_MS = 450;

/**
 * The AI assistant's explanation of a finding. While it is being written it streams in: the worker saves the text
 * as it arrives, this polls for it, and a typewriter smooths the bursts into a steady flow with a caret at its end
 * and a light haptic tick as the words land. An explanation that was finished before the page opened is shown at
 * once. Give it the explanation's id as its key, so each new explanation starts from nothing.
 */
export function AiExplanation({
  path,
  latest,
  strategyName,
  timeZone,
}: {
  path: { orgId: string; buildingId: string; findingId: string };
  latest: Explanation | undefined;
  strategyName: (id: string) => string | undefined;
  timeZone: string;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const pending = latest?.status === "pending";
  const live = useQuery({
    queryKey: ["explanation", latest?.id],
    enabled: pending,
    queryFn: () =>
      unwrap(
        api.GET(
          "/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}/explanations/{explanationId}",
          { params: { path: { ...path, explanationId: latest!.id } } },
        ),
      ),
    refetchInterval: (q) => (!q.state.data || q.state.data.status === "pending" ? POLL_MS : false),
  });
  const current: Explanation | undefined =
    pending && live.data?.id === latest?.id ? (live.data as Explanation) : latest;

  // once it is finished, the finding's own list catches up
  const settled = live.data && live.data.status !== "pending";
  useEffect(() => {
    if (settled) qc.invalidateQueries({ queryKey: ["finding", path.findingId], exact: true });
  }, [settled, qc, path.findingId]);

  // only explanations seen being written are typed out
  const watched = useRef(new Set<string>());
  if (current?.status === "pending") watched.current.add(current.id);
  const streams = !!current && watched.current.has(current.id) && current.status !== "failed";

  const answer = useMemo(() => (current ? answerOf(current) : null), [current]);
  const segments = useMemo(() => {
    if (!answer) return [];
    return [
      { key: "what", text: answer.whatHappened },
      ...answer.likelyCauses.map((text, i) => ({ key: `cause-${i}`, text })),
      { key: "outlook", text: answer.outlook },
      { key: "action", text: strategyName(answer.strategyId) ?? "" },
      { key: "reason", text: answer.reason },
      ...answer.uncertainties.map((text, i) => ({ key: `unsure-${i}`, text })),
      ...answer.basis.map((text, i) => ({ key: `basis-${i}`, text })),
    ];
  }, [answer, strategyName]);
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  const done = current?.status === "done";
  const shown = useTypewriter(total, streams, done, locale === "zh" ? "zh" : "en");

  if (!current) return null;
  if (current.status === "failed")
    return (
      <p className="mt-3 text-sm text-danger">
        {t.findings.aiFailed}: {current.error}
      </p>
    );
  if (!answer || total === 0)
    return current.status === "pending" ? (
      <div className="mt-4 space-y-2.5" aria-busy>
        <p className="inline-flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 animate-pulse text-accent" aria-hidden />
          <span className="fc-stream-wait">{t.findings.aiPending}</span>
        </p>
        <div className="fc-skel h-3 w-11/12" />
        <div className="fc-skel h-3 w-4/5" />
        <div className="fc-skel h-3 w-2/3" />
      </div>
    ) : null;

  // how much of each piece is out, and where the caret sits (the end of the last piece with text)
  const visible = new Map<string, string>();
  let left = shown;
  let caret: string | null = null;
  for (const s of segments) {
    const n = Math.max(0, Math.min(s.text.length, left));
    visible.set(s.key, s.text.slice(0, n));
    if (n > 0) caret = s.key;
    left -= s.text.length;
  }
  const writing = current.status === "pending" || shown < total;
  const enter = streams ? "fc-stream-in" : "";
  const text = (key: string): ReactNode => {
    const v = visible.get(key) ?? "";
    return (
      <>
        {v}
        {writing && caret === key ? <span className="fc-stream-caret" aria-hidden /> : null}
      </>
    );
  };
  const has = (key: string) => !!visible.get(key);
  const causes = answer.likelyCauses.map((_, i) => `cause-${i}`).filter(has);
  const unsure = answer.uncertainties.map((_, i) => `unsure-${i}`).filter(has);
  const basis = answer.basis.map((_, i) => `basis-${i}`).filter(has);

  return (
    <div className="mt-3 space-y-3 text-sm" aria-busy={writing}>
      {has("what") ? (
        <section className={enter}>
          <h3 className="text-xs font-semibold text-muted">{t.findings.aiWhat}</h3>
          <p>{text("what")}</p>
        </section>
      ) : null}
      {causes.length ? (
        <section className={enter}>
          <h3 className="text-xs font-semibold text-muted">{t.findings.aiCauses}</h3>
          <ul className="list-disc pl-5">
            {causes.map((key) => (
              <li key={key}>{text(key)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {has("outlook") ? (
        <section className={enter}>
          <h3 className="text-xs font-semibold text-muted">{t.findings.aiOutlook}</h3>
          <p>{text("outlook")}</p>
        </section>
      ) : null}
      {has("action") ? (
        <section className={`rounded-lg bg-accent-soft p-3 ${enter}`}>
          <h3 className="text-xs font-semibold text-accent">{t.findings.aiAction}</h3>
          <p className="font-medium">{text("action")}</p>
          {has("reason") ? <p>{text("reason")}</p> : null}
        </section>
      ) : null}
      {unsure.length ? (
        <section className={enter}>
          <h3 className="text-xs font-semibold text-muted">{t.findings.aiUncertain}</h3>
          <ul className="list-disc pl-5 text-xs text-muted">
            {unsure.map((key) => (
              <li key={key}>{text(key)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {basis.length ? (
        <section className={enter}>
          <h3 className="text-xs font-semibold text-muted">{t.findings.aiBasis}</h3>
          <ul className="list-disc pl-5 text-xs">
            {basis.map((key) => (
              <li key={key}>{text(key)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {done && !writing ? (
        <p className={`text-[11px] text-muted ${enter}`}>
          {current.model} · {current.promptVersion} · {dateTime(current.completedAt, locale, timeZone)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * How many characters to show. Without `streams` everything shows at once. Otherwise the count climbs every frame
 * toward `total` (which grows as text arrives), never slower than the base rate and fast enough to stay within
 * LAG_S of the text; each few characters a light haptic tick lands, and a confirming one when it is all out.
 */
function useTypewriter(total: number, streams: boolean, done: boolean, lang: "en" | "zh") {
  const [shown, setShown] = useState(0);
  const count = useRef(0);
  const target = useRef(total);
  target.current = total;
  const finished = useRef(done);
  finished.current = done;

  useEffect(() => {
    if (!streams) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    let tickAt = 0;
    let tickCount = count.current;
    let confirmed = false;
    const step = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      const goal = target.current;
      if (count.current > goal) count.current = goal; // the text started over (a fallback model took over)
      if (count.current < goal) {
        const rate = Math.max(BASE_RATE[lang], (goal - count.current) / LAG_S);
        count.current = reduced ? goal : Math.min(goal, count.current + rate * dt);
        const whole = Math.floor(count.current);
        setShown(whole);
        if (!reduced && whole - tickCount >= TICK_CHARS[lang] && now - tickAt >= TICK_MS) {
          feel("tick");
          tickAt = now;
          tickCount = whole;
        }
      } else if (finished.current && !confirmed) {
        confirmed = true;
        setShown(goal);
        if (!reduced) feel("confirm");
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [streams, lang]);

  return streams ? shown : total;
}
