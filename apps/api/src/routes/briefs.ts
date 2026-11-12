import { schema, type Tx } from "@flowcarbon/db";
import { and, desc, eq, gt, inArray, ne, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { assertAiQuota } from "../ai-quota";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { notFound } from "../errors";
import { userNames } from "../measures";
import { buildingParams, errorResponses, iso, localeBody, localeSchema, uuid } from "../schemas";
import { inBuilding } from "./helpers";

const briefOut = z.object({
  id: uuid,
  /** the language it is written in */
  locale: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  model: z.string().nullable(),
  /** headline, priorities (floor, ruleId, strategyId, why, floorId, findings, avoidableKwh, avoidableCost, findingId, measureId when its finding has gone into a measure since), watch */
  output: z.record(z.string(), z.unknown()).nullable(),
  /** while pending: what has been written so far (partial JSON) */
  draft: z.string().nullable(),
  error: z.string().nullable(),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** a measure of the building was created, implemented or cancelled after the brief was completed */
  outdated: z.boolean(),
});
type BriefRow = typeof schema.aiBriefs.$inferSelect;
const briefJson = (b: BriefRow, names: Map<string, string>) => ({
  id: b.id,
  locale: b.locale,
  status: b.status,
  model: b.model,
  output: b.output,
  draft: b.status === "pending" ? b.draft : null,
  error: b.error,
  requestedBy: b.requestedBy ? (names.get(b.requestedBy) ?? null) : null,
  createdAt: b.createdAt.toISOString(),
  completedAt: iso(b.completedAt),
});

/**
 * A brief is written once, but its findings move on: the measure a priority's finding is in now, which rules out
 * adopting it again, however that measure came about.
 */
async function withMeasures(tx: Tx, output: BriefRow["output"]) {
  const priorities = (output as { priorities?: { findingId?: string }[] } | null)?.priorities;
  const ids = (priorities ?? []).flatMap((p) => p.findingId ?? []);
  if (!ids.length) return output;
  const rows = await tx
    .select({ id: schema.findings.id, measureId: schema.findings.measureId })
    .from(schema.findings)
    .innerJoin(schema.measures, eq(schema.measures.id, schema.findings.measureId))
    .where(and(inArray(schema.findings.id, ids), ne(schema.measures.status, "cancelled")));
  const taken = new Map(rows.map((r) => [r.id, r.measureId]));
  return {
    ...output,
    priorities: priorities!.map((p) => {
      const measureId = p.findingId && taken.get(p.findingId);
      return measureId ? { ...p, measureId } : p;
    }),
  };
}

/** Whether the building's measures moved on after the brief was written, so its advice may no longer fit. */
async function isOutdated(tx: Tx, row: BriefRow) {
  // The worker reads the building when the job starts, so a measure adopted while the text was being written is not
  // in it either: compare with when the brief was asked for, not when it finished.
  const done = row.createdAt;
  if (row.status !== "done" || !row.completedAt || !done) return false;
  const [changed] = await tx
    .select({ id: schema.measures.id })
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.buildingId, row.buildingId),
        or(
          gt(schema.measures.createdAt, done),
          gt(schema.measures.implementedAt, done),
          gt(schema.measures.cancelledAt, done),
        ),
      ),
    )
    .limit(1);
  return Boolean(changed);
}

const shownBrief = async (tx: Tx, row: BriefRow) => ({
  ...briefJson(row, await userNames(tx, [row.requestedBy])),
  output: await withMeasures(tx, row.output),
  outdated: await isOutdated(tx, row),
});

/** The AI assistant's look at a whole building: where to start, across all open findings. */
export const briefRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs, config }) => {
  app.post(
    "/orgs/:orgId/buildings/:buildingId/briefs",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["analytics"],
        summary:
          "Ask the AI assistant which groups of open findings to act on first, in one language (asynchronous, streamed)",
        params: buildingParams,
        body: localeBody,
        response: { 202: z.object({ briefId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const id = await inBuilding(db, req, req.params, "finding:explain", async (tx, access, b) => {
        const { locale } = req.body;
        const [pending] = await tx
          .select({ id: schema.aiBriefs.id })
          .from(schema.aiBriefs)
          .where(
            and(
              eq(schema.aiBriefs.buildingId, b.id),
              eq(schema.aiBriefs.locale, locale),
              eq(schema.aiBriefs.status, "pending"),
            ),
          );
        if (pending) return pending.id;
        await assertAiQuota(tx, access.orgId, config.DEMO_AI_PER_DAY);
        const [row] = await tx
          .insert(schema.aiBriefs)
          .values({
            orgId: access.orgId,
            buildingId: b.id,
            locale,
            promptVersion: "pending",
            input: {},
            requestedBy: access.actor.type === "user" ? access.actor.id : null,
          })
          .returning({ id: schema.aiBriefs.id });
        await audit(tx, req, access, {
          action: "building.brief",
          entityType: "building",
          entityId: b.id,
          data: { locale },
        });
        return row!.id;
      });
      await jobs.brief({ orgId: req.params.orgId, briefId: id });
      return reply.status(202).send({ briefId: id });
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/briefs/latest",
    {
      schema: {
        tags: ["analytics"],
        summary:
          "The building's latest AI brief in a language (in any language if none is given), if there is one",
        params: buildingParams,
        querystring: z.object({ locale: localeSchema.optional() }),
        response: {
          200: z.object({
            brief: briefOut.nullable(),
            /** a finished brief exists in another language than the one asked for */
            otherLocale: z.boolean(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, _a, b) => {
        const { locale } = req.query;
        const [row] = await tx
          .select()
          .from(schema.aiBriefs)
          .where(
            and(
              eq(schema.aiBriefs.buildingId, b.id),
              locale ? eq(schema.aiBriefs.locale, locale) : undefined,
            ),
          )
          .orderBy(desc(schema.aiBriefs.createdAt))
          .limit(1);
        const other = locale
          ? await tx
              .select({ id: schema.aiBriefs.id })
              .from(schema.aiBriefs)
              .where(
                and(
                  eq(schema.aiBriefs.buildingId, b.id),
                  ne(schema.aiBriefs.locale, locale),
                  eq(schema.aiBriefs.status, "done"),
                ),
              )
              .limit(1)
          : [];
        return {
          brief: row ? await shownBrief(tx, row) : null,
          otherLocale: other.length > 0,
        };
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/briefs/:briefId",
    {
      // polled about twice a second while the brief streams in
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["analytics"],
        summary: "One AI brief, including the text written so far while it is pending",
        params: buildingParams.extend({ briefId: uuid }),
        response: { 200: briefOut, ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, _a, b) => {
        const [row] = await tx
          .select()
          .from(schema.aiBriefs)
          .where(and(eq(schema.aiBriefs.id, req.params.briefId), eq(schema.aiBriefs.buildingId, b.id)));
        if (!row) throw notFound("Brief");
        return shownBrief(tx, row);
      }),
  );
};
