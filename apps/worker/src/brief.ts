import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { RULES, STRATEGIES } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import { loadBuildingContext, localDateOf } from "@flowcarbon/pipeline";
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ExplainDeps } from "./explain";

export const BRIEF_PROMPT_VERSION = "brief-v1";
/** days of open findings the assistant looks at */
const WINDOW_DAYS = 14;
/** groups of findings handed to the model, largest first */
const MAX_GROUPS = 12;
const DRAFT_EVERY_MS = 250;

const RULE_IDS = Object.keys(RULES) as [string, ...string[]];
const STRATEGY_IDS = [
  "occupancy_gated_workday",
  "zone_only_non_working",
  "auto_lights_off",
  "investigate_on_site",
  "no_action",
] as const;

export const briefSchema = z.object({
  headline: z
    .string()
    .describe(
      "At most two sentences: where this building loses most, and what to do first, with the key number.",
    ),
  priorities: z
    .array(
      z.object({
        floor: z.string().describe("Floor label exactly as in the groups, e.g. F5."),
        ruleId: z.enum(RULE_IDS),
        strategyId: z.enum(STRATEGY_IDS),
        why: z
          .string()
          .describe("One or two sentences with the numbers that make this group worth acting on."),
      }),
    )
    .describe("Up to four groups to act on, most valuable first. Skip groups that already have a measure."),
  watch: z
    .array(z.string())
    .describe("Up to three short notes: measures already in effect worth checking, or caveats in the data."),
});
const OUTPUT_FORMAT = { type: "json_schema" as const, schema: betaZodOutputFormat(briefSchema).schema };

const SYSTEM = `You help the operations team of an office building decide where to start. Deterministic rules have already found the findings and how much energy each could have saved; you do not re-judge them and you change no settings. You get the open findings of the last two weeks grouped by floor and kind, plus the measures the team has already agreed.

Pick at most four groups worth acting on, most valuable first: weigh the avoidable energy, how often it recurs, and whether one change would fix it. For each, choose one strategy from the list ("investigate_on_site" when the pattern suggests a fault, "no_action" when the use looks legitimate). Leave out groups that already have a planned or active measure; mention a measure in effect under "watch" if its floor still shows the kind of finding it should have stopped.

Write plainly, without marketing language, and use only the numbers given. Keep it short: the headline about 40 words in English or 60 characters in Chinese, each reason about 30 words or 50 characters.`;

/** Groups the building's recent open findings by floor and rule, largest first. */
export async function briefInput(db: Db, orgId: string, briefId: string, now = Date.now()) {
  return withOrg(db, orgId, async (tx) => {
    const [brief] = await tx.select().from(schema.aiBriefs).where(eq(schema.aiBriefs.id, briefId));
    if (!brief) return null;
    const ctx = await loadBuildingContext(tx, orgId, brief.buildingId);
    const since = new Date(now - WINDOW_DAYS * 86_400_000);
    const open = await tx
      .select()
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.buildingId, brief.buildingId),
          eq(schema.findings.status, "open"),
          gte(schema.findings.startAt, since),
        ),
      );
    const label = new Map(ctx.floors.map((f) => [f.id, f.label]));
    const groups = new Map<
      string,
      {
        floorId: string;
        floor: string;
        ruleId: string;
        count: number;
        kwh: number;
        cost: number;
        days: Set<string>;
        dayTypes: Set<string>;
        peakPeople: number;
        latest: { id: string; at: number };
      }
    >();
    for (const f of open) {
      const key = `${f.floorId}|${f.ruleId}`;
      const g = groups.get(key) ?? {
        floorId: f.floorId,
        floor: label.get(f.floorId) ?? "?",
        ruleId: f.ruleId,
        count: 0,
        kwh: 0,
        cost: 0,
        days: new Set<string>(),
        dayTypes: new Set<string>(),
        peakPeople: 0,
        latest: { id: f.id, at: 0 },
      };
      g.count++;
      g.kwh += f.avoidableKwh;
      g.cost += f.avoidableCost;
      g.days.add(localDateOf(ctx, f.startAt.getTime()));
      g.dayTypes.add(f.dayType);
      g.peakPeople = Math.max(g.peakPeople, f.peakPeople);
      if (f.startAt.getTime() > g.latest.at) g.latest = { id: f.id, at: f.startAt.getTime() };
      groups.set(key, g);
    }
    const top = [...groups.values()].sort((a, b) => b.kwh - a.kwh).slice(0, MAX_GROUPS);
    const measures = await tx
      .select()
      .from(schema.measures)
      .where(
        and(
          eq(schema.measures.buildingId, brief.buildingId),
          inArray(schema.measures.status, ["planned", "in_effect"]),
        ),
      );
    let locale = "en";
    if (brief.requestedBy) {
      const [u] = await tx
        .select({ locale: schema.users.locale })
        .from(schema.users)
        .where(eq(schema.users.id, brief.requestedBy));
      locale = u?.locale ?? "en";
    }
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      brief,
      locale,
      groups: top,
      input: {
        building: {
          name: ctx.building.name,
          currency: ctx.building.currency,
          // labels, not a count: floors are often numbered from where the offices start
          floors: ctx.floors.map((f) => f.label),
        },
        window: {
          days: WINDOW_DAYS,
          from: localDateOf(ctx, since.getTime()),
          to: localDateOf(ctx, now),
        },
        groups: top.map((g) => ({
          floor: g.floor,
          ruleId: g.ruleId,
          rule: RULES[g.ruleId as keyof typeof RULES]?.name ?? g.ruleId,
          findings: g.count,
          daysWithFindings: g.days.size,
          dayTypes: [...g.dayTypes],
          avoidableKwh: round(g.kwh),
          avoidableCost: round(g.cost),
          peakPeople: g.peakPeople,
        })),
        measures: measures.map((m) => ({
          floor: label.get(m.floorId) ?? "?",
          strategyId: m.strategyId,
          status: m.status,
          since: (m.implementedAt ?? m.createdAt).toISOString().slice(0, 10),
        })),
        strategies: [
          ...Object.values(STRATEGIES).map((s) => ({ id: s.id, name: s.name, description: s.description })),
          {
            id: "investigate_on_site",
            name: "Investigate on site",
            description: "Check the BMS schedule, overrides and sensors first.",
          },
          { id: "no_action", name: "No action", description: "The use was legitimate; keep the record." },
        ],
      },
    };
  });
}

/** Writes one building brief, streaming what it has so far into `draft`. Throws on retryable API failures. */
export async function runBrief(
  deps: ExplainDeps,
  payload: { orgId: string; briefId: string },
  now = Date.now(),
): Promise<"done" | "failed" | "skipped"> {
  const { db } = deps;
  const { orgId, briefId } = payload;
  const data = await briefInput(db, orgId, briefId, now);
  if (data?.brief.status !== "pending") return "skipped";
  const update = (set: Partial<typeof schema.aiBriefs.$inferInsert>) =>
    withOrg(db, orgId, (tx) =>
      tx
        .update(schema.aiBriefs)
        .set(set)
        .where(and(eq(schema.aiBriefs.id, briefId), eq(schema.aiBriefs.status, "pending"))),
    );
  const fail = async (error: string) => {
    await update({
      status: "failed",
      draft: null,
      error,
      promptVersion: BRIEF_PROMPT_VERSION,
      input: data.input,
      completedAt: new Date(),
    });
    return "failed" as const;
  };
  if (!data.groups.length) {
    // nothing open: say so without asking the model
    const zh = data.locale.startsWith("zh");
    await update({
      status: "done",
      draft: null,
      promptVersion: BRIEF_PROMPT_VERSION,
      input: data.input,
      output: {
        headline: zh
          ? "最近两周没有待处理的机会点。已实施的措施可以在“措施”里看效果。"
          : "No open opportunities in the last two weeks. See Measures for how the ones in effect are doing.",
        priorities: [],
        watch: [],
      },
      completedAt: new Date(),
    });
    return "done";
  }

  if (!deps.client) return fail("AI is not configured for this deployment.");

  const language = data.locale.startsWith("zh") ? "Simplified Chinese" : "English";
  let draft = "";
  let savedAt = 0;
  let saving: Promise<unknown> = Promise.resolve();
  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    const stream = deps.client.beta.messages.stream({
      model: deps.model,
      max_tokens: 8_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: deps.effort, format: OUTPUT_FORMAT },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Write the brief in ${language}. All data below comes from the building's own records.\n\n<data>\n${JSON.stringify(data.input, null, 1)}\n</data>`,
        },
      ],
    });
    stream.on("text", (_delta, snapshot) => {
      draft = snapshot;
      if (Date.now() - savedAt < DRAFT_EVERY_MS) return;
      savedAt = Date.now();
      const text = draft;
      saving = saving
        .then(() => update({ draft: text }))
        .catch((err) => deps.log?.({ briefId, err: String(err) }, "brief draft not saved"));
    });
    response = await stream.finalMessage();
  } catch (err) {
    await saving;
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    )
      throw err;
    if (err instanceof Anthropic.APIError && (err.status ?? 500) >= 500) throw err;
    if (err instanceof Anthropic.APIError)
      return fail(`The AI service rejected the request (${err.status}): ${err.message.slice(0, 300)}`);
    throw err;
  }
  await saving;

  if (response.stop_reason === "refusal") return fail("The AI service declined to write this brief.");
  if (response.stop_reason === "max_tokens") return fail("The brief was cut off.");
  const text = response.content.filter((b) => b.type === "text").at(-1)?.text ?? "";
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // reported below
  }
  const checked = briefSchema.safeParse(value);
  if (!checked.success) return fail("The AI response did not match the expected structure.");
  // only groups that were in the input, each tied to its numbers and a finding to act from
  const byKey = new Map(data.groups.map((g) => [`${g.floor}|${g.ruleId}`, g]));
  const seen = new Set<string>();
  const priorities = checked.data.priorities.flatMap((p) => {
    const g = byKey.get(`${p.floor}|${p.ruleId}`);
    if (!g || seen.has(`${p.floor}|${p.ruleId}`)) return [];
    seen.add(`${p.floor}|${p.ruleId}`);
    return [
      {
        ...p,
        floorId: g.floorId,
        findings: g.count,
        avoidableKwh: Math.round(g.kwh * 10) / 10,
        avoidableCost: Math.round(g.cost * 100) / 100,
        findingId: g.latest.id,
      },
    ];
  });
  await update({
    status: "done",
    draft: null,
    model: response.model,
    promptVersion: BRIEF_PROMPT_VERSION,
    input: data.input,
    output: {
      headline: checked.data.headline,
      priorities: priorities.slice(0, 4),
      watch: checked.data.watch.slice(0, 3),
    },
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    completedAt: new Date(),
  });
  deps.log?.(
    {
      briefId,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    "brief stored",
  );
  return "done";
}
