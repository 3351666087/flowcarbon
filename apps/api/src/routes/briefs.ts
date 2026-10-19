import { schema } from "@flowcarbon/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { assertAiQuota } from "../ai-quota";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { notFound } from "../errors";
import { userNames } from "../measures";
import { buildingParams, errorResponses, iso, uuid } from "../schemas";
import { inBuilding } from "./helpers";

const briefOut = z.object({
  id: uuid,
  status: z.enum(["pending", "done", "failed"]),
  model: z.string().nullable(),
  /** headline, priorities (floor, ruleId, strategyId, why, floorId, findings, avoidableKwh, avoidableCost, findingId), watch */
  output: z.record(z.string(), z.unknown()).nullable(),
  /** while pending: what has been written so far (partial JSON) */
  draft: z.string().nullable(),
  error: z.string().nullable(),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
type BriefRow = typeof schema.aiBriefs.$inferSelect;
const briefJson = (b: BriefRow, names: Map<string, string>) => ({
  id: b.id,
  status: b.status,
  model: b.model,
  output: b.output,
  draft: b.status === "pending" ? b.draft : null,
  error: b.error,
  requestedBy: b.requestedBy ? (names.get(b.requestedBy) ?? null) : null,
  createdAt: b.createdAt.toISOString(),
  completedAt: iso(b.completedAt),
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
          "Ask the AI assistant which groups of open findings to act on first (asynchronous, streamed)",
        params: buildingParams,
        response: { 202: z.object({ briefId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const id = await inBuilding(db, req, req.params, "finding:explain", async (tx, access, b) => {
        const [pending] = await tx
          .select({ id: schema.aiBriefs.id })
          .from(schema.aiBriefs)
          .where(and(eq(schema.aiBriefs.buildingId, b.id), eq(schema.aiBriefs.status, "pending")));
        if (pending) return pending.id;
        await assertAiQuota(tx, access.orgId, config.DEMO_AI_PER_DAY);
        const [row] = await tx
          .insert(schema.aiBriefs)
          .values({
            orgId: access.orgId,
            buildingId: b.id,
            promptVersion: "pending",
            input: {},
            requestedBy: access.actor.type === "user" ? access.actor.id : null,
          })
          .returning({ id: schema.aiBriefs.id });
        await audit(tx, req, access, { action: "building.brief", entityType: "building", entityId: b.id });
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
        summary: "The building's latest AI brief, if there is one",
        params: buildingParams,
        response: { 200: z.object({ brief: briefOut.nullable() }), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, _a, b) => {
        const [row] = await tx
          .select()
          .from(schema.aiBriefs)
          .where(eq(schema.aiBriefs.buildingId, b.id))
          .orderBy(desc(schema.aiBriefs.createdAt))
          .limit(1);
        if (!row) return { brief: null };
        return { brief: briefJson(row, await userNames(tx, [row.requestedBy])) };
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
        return briefJson(row, await userNames(tx, [row.requestedBy]));
      }),
  );
};
