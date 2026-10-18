import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  DEFAULT_RULE_PARAMS,
  RULE_PARAM_RATIONALE,
  RULES,
  SCHEDULE_LABELS,
  STRATEGIES,
} from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import { loadBuildingContext, localDateOf } from "@flowcarbon/pipeline";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { REFERENCE_IDS, REFERENCES } from "./references";

export const PROMPT_VERSION = "explain-v1";

/** how often the partly written explanation is saved while it streams */
const DRAFT_EVERY_MS = 250;

const STRATEGY_IDS = [
  "occupancy_gated_workday",
  "zone_only_non_working",
  "auto_lights_off",
  "investigate_on_site",
  "no_action",
] as const;

export const explanationSchema = z.object({
  whatHappened: z
    .string()
    .describe("One or two sentences stating what the evidence shows, with the key numbers."),
  likelyCauses: z.array(z.string()).describe("One to three plausible operational causes, most likely first."),
  outlook: z.string().describe("What the forecast suggests for this floor over the coming days."),
  recommendedAction: z.object({
    strategyId: z.enum(STRATEGY_IDS),
    reason: z.string().describe("Why this action fits the evidence."),
  }),
  basis: z
    .array(z.enum(REFERENCE_IDS))
    .describe("Reference ids from the provided list that support the recommendation."),
  uncertainties: z
    .array(z.string())
    .describe("What the data cannot show, e.g. estimated rather than metered energy."),
});

// the schema only, without the SDK's parser: the stream would otherwise throw on a text block that is not the answer
// (a declined attempt before a fallback); the response is validated against explanationSchema below instead
const OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: betaZodOutputFormat(explanationSchema).schema,
};
export type Explanation = z.infer<typeof explanationSchema>;

const SYSTEM = `You explain energy findings for the operations team of an office building. A deterministic rule has already decided that the finding exists and how much energy was avoidable; you do not re-judge it and you do not change any setting. Your reader is a property manager or an energy engineer who will decide what to do.

Write plainly, without marketing language. Use only the numbers given in the evidence and the forecast; do not compute new totals. Recommend exactly one action from the strategy list (or "investigate_on_site" when the evidence points to a fault, or "no_action" when the use was legitimate). Cite only reference ids from the reference list, and only where the reference actually supports the point. State uncertainty honestly: estimated energy is rated power times run time, door counts can miss people, and the forecast is a median of recent same-weekday values.

Keep the whole explanation short: about 110 words in English, or about 110 characters per field in Chinese.`;

export interface ExplainDeps {
  db: Db;
  client: Pick<Anthropic, "beta"> | null;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

/** Builds the model input from stored data only; nothing here comes from the requester. */
export async function explanationInput(db: Db, orgId: string, explanationId: string) {
  return withOrg(db, orgId, async (tx) => {
    const [row] = await tx
      .select({ explanation: schema.aiExplanations, finding: schema.findings })
      .from(schema.aiExplanations)
      .innerJoin(schema.findings, eq(schema.findings.id, schema.aiExplanations.findingId))
      .where(eq(schema.aiExplanations.id, explanationId));
    if (!row) return null;
    const { finding: f, explanation: e } = row;
    const ctx = await loadBuildingContext(tx, orgId, f.buildingId);
    const floor = ctx.floors.find((x) => x.id === f.floorId);
    const tenant = floor?.tenantId ? ctx.tenants.find((t) => t.id === floor.tenantId) : undefined;
    const today = localDateOf(ctx, Date.now());
    const forecast = await tx
      .select()
      .from(schema.forecasts)
      .where(and(eq(schema.forecasts.floorId, f.floorId), gte(schema.forecasts.day, today)))
      .orderBy(schema.forecasts.day)
      .limit(7);
    let locale = "en";
    if (e.requestedBy) {
      const [u] = await tx
        .select({ locale: schema.users.locale })
        .from(schema.users)
        .where(eq(schema.users.id, e.requestedBy));
      locale = u?.locale ?? "en";
    }
    const rule = RULES[f.ruleId as keyof typeof RULES];
    const params = { ...DEFAULT_RULE_PARAMS, ...(f.params as object) };
    return {
      explanation: e,
      locale,
      input: {
        building: {
          name: ctx.building.name,
          timezone: ctx.building.timezone,
          currency: ctx.building.currency,
          afterHoursStart: ctx.building.afterHoursStart,
          workdayStart: ctx.building.workdayStart,
        },
        floor: floor
          ? {
              label: floor.label,
              areaM2: floor.areaM2,
              ratedHvacKw: floor.ratedHvacKw,
              ratedLightingKw: floor.ratedLightingKw,
              tenant: tenant?.name ?? null,
            }
          : null,
        finding: {
          rule: rule
            ? {
                id: rule.id,
                name: rule.name,
                kind: rule.kind,
                physics: rule.physics,
                quantification: rule.quantification,
              }
            : { id: f.ruleId },
          localDate: localDateOf(ctx, f.startAt.getTime()),
          start: f.startAt.toISOString(),
          end: f.endAt.toISOString(),
          dayType: f.dayType,
          avoidableKwh: f.avoidableKwh,
          avoidableCost: f.avoidableCost,
          avoidableCo2eKg: f.avoidableCo2eKg,
          peakPeople: f.peakPeople,
          dataTier: f.tier,
          evidence: f.evidence,
          status: f.status,
        },
        thresholds: Object.entries(params).map(([name, value]) => ({
          name,
          value,
          rationale: RULE_PARAM_RATIONALE[name as keyof typeof RULE_PARAM_RATIONALE],
        })),
        forecast: forecast.map((d) => ({
          day: d.day,
          dayType: d.dayType,
          median: d.median,
          low: d.low,
          high: d.high,
          basisDays: d.basis,
          advice: SCHEDULE_LABELS[d.advice],
        })),
        strategies: [
          ...Object.values(STRATEGIES).map((s) => ({ id: s.id, name: s.name, description: s.description })),
          {
            id: "investigate_on_site",
            name: "Investigate on site",
            description:
              "Check the BMS schedule, overrides and sensors on the floor before changing anything.",
          },
          {
            id: "no_action",
            name: "No action",
            description: "The use was legitimate (e.g. approved work); keep the finding for the record.",
          },
        ],
        references: Object.entries(REFERENCES).map(([id, r]) => ({ id, ...r })),
      },
    };
  });
}

/** Generates and stores one explanation. Throws on retryable API failures so the queue retries. */
export async function runExplain(
  deps: ExplainDeps,
  payload: { orgId: string; explanationId: string },
): Promise<"done" | "failed" | "skipped"> {
  const { db } = deps;
  const { orgId } = payload;
  const data = await explanationInput(db, orgId, payload.explanationId);
  if (data?.explanation.status !== "pending") return "skipped";
  const fail = async (error: string) => {
    await withOrg(db, orgId, (tx) =>
      tx
        .update(schema.aiExplanations)
        .set({
          status: "failed",
          draft: null,
          error,
          promptVersion: PROMPT_VERSION,
          input: data.input,
          completedAt: new Date(),
        })
        .where(eq(schema.aiExplanations.id, payload.explanationId)),
    );
    return "failed" as const;
  };
  if (!deps.client) return fail("AI explanations are not configured for this deployment.");

  const language = data.locale.startsWith("zh") ? "Simplified Chinese" : "English";
  // the explanation streams; what has been written so far is saved every DRAFT_EVERY_MS so the page can show it
  // arriving instead of waiting for the whole response
  let draft = "";
  let savedAt = 0;
  let saving: Promise<unknown> = Promise.resolve();
  const saveDraft = () => {
    const text = draft;
    saving = saving
      .then(() =>
        withOrg(db, orgId, (tx) =>
          tx
            .update(schema.aiExplanations)
            .set({ draft: text })
            .where(
              and(
                eq(schema.aiExplanations.id, payload.explanationId),
                eq(schema.aiExplanations.status, "pending"),
              ),
            ),
        ),
      )
      .catch((err) =>
        deps.log?.({ explanationId: payload.explanationId, err: String(err) }, "draft not saved"),
      );
  };
  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    const stream = deps.client.beta.messages.stream({
      model: deps.model,
      max_tokens: 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: deps.effort, format: OUTPUT_FORMAT },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Explain this finding in ${language}. All data below comes from the building's own records.\n\n<data>\n${JSON.stringify(data.input, null, 1)}\n</data>`,
        },
      ],
    });
    // the snapshot is the current text block; after a fallback it starts again with the fallback model's text
    stream.on("text", (_delta, snapshot) => {
      draft = snapshot;
      if (Date.now() - savedAt >= DRAFT_EVERY_MS) {
        savedAt = Date.now();
        saveDraft();
      }
    });
    response = await stream.finalMessage();
  } catch (err) {
    await saving;
    // 4xx other than rate limits will not succeed on retry
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    )
      throw err;
    if (err instanceof Anthropic.APIError && (err.status ?? 500) >= 500) throw err;
    if (err instanceof Anthropic.APIError) {
      deps.log?.(
        {
          explanationId: payload.explanationId,
          status: err.status,
          error: err.message,
          requestId: err.requestID,
        },
        "AI request rejected",
      );
      return fail(`The AI service rejected the request (${err.status}): ${err.message.slice(0, 300)}`);
    }
    throw err;
  }
  await saving;

  const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  if (response.stop_reason === "refusal") return fail("The AI service declined to explain this finding.");
  if (response.stop_reason === "max_tokens") return fail("The explanation was cut off.");
  // the answer is the last text block (earlier ones belong to a model that declined and handed over)
  const text = response.content.filter((block) => block.type === "text").at(-1)?.text ?? "";
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // reported below as a structure mismatch
  }
  const checked = explanationSchema.safeParse(value);
  if (!checked.success) return fail("The AI response did not match the expected structure.");
  const output = {
    ...checked.data,
    basis: [...new Set(checked.data.basis)].map((id) => ({ id, title: REFERENCES[id].title })),
  };

  await withOrg(db, orgId, (tx) =>
    tx
      .update(schema.aiExplanations)
      .set({
        status: "done",
        model: response.model,
        promptVersion: PROMPT_VERSION,
        input: data.input,
        output,
        draft: null,
        error: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        completedAt: new Date(),
      })
      .where(eq(schema.aiExplanations.id, payload.explanationId)),
  );
  deps.log?.({ explanationId: payload.explanationId, model: response.model, ...usage }, "explanation stored");
  return "done";
}
