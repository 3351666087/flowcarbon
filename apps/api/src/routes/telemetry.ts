import { zonedTime } from "@flowcarbon/core";
import { schema } from "@flowcarbon/db";
import { ingestBatchSchema, ingestTelemetry, MAX_BATCH_ITEMS } from "@flowcarbon/pipeline";
import { randomToken } from "@flowcarbon/security";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { badRequest, unprocessable } from "../errors";
import { buildingParams, dateKey, errorResponses, iso, uuid } from "../schemas";
import { addDaysKey, todayIn, withBuildingContext } from "./helpers";

export const telemetryRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs }) => {
  app.post(
    "/orgs/:orgId/buildings/:buildingId/telemetry",
    {
      bodyLimit: 16 * 1024 * 1024,
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["telemetry"],
        summary: `Ingest a batch of telemetry (at most ${MAX_BATCH_ITEMS} items). Retries with the same Idempotency-Key are safe.`,
        description:
          "Devices are addressed by their external id. The batch is validated as a whole and either stored completely or rejected with reasons. Processing (intervals, findings) runs asynchronously; poll the ingestion batches to see when it is done.",
        params: buildingParams,
        headers: z.object({
          "idempotency-key": z
            .string()
            .min(8)
            .max(128)
            .regex(/^[\x21-\x7e]+$/),
        }),
        body: ingestBatchSchema,
        response: {
          202: z.object({
            batchId: uuid,
            duplicate: z.boolean(),
            counts: z.record(z.string(), z.number()),
            affected: z.object({ fromDate: z.string(), toDateExclusive: z.string() }).nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const result = await withBuildingContext(db, req, req.params, "telemetry:write", (tx, access, ctx) =>
        ingestTelemetry(tx, ctx, {
          batch: req.body,
          idempotencyKey: req.headers["idempotency-key"],
          apiKeyId: access.actor.type === "api_key" ? access.actor.id : null,
        }),
      );
      if (!result.duplicate)
        await jobs.recompute({ orgId: req.params.orgId, buildingId: req.params.buildingId });
      return reply.status(202).send(result);
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/ingestion-batches",
    {
      schema: {
        tags: ["telemetry"],
        summary: "Recent ingestion batches and their processing state",
        params: buildingParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          pending: z.coerce.boolean().optional(),
        }),
        response: {
          200: z.array(
            z.object({
              id: uuid,
              idempotencyKey: z.string(),
              counts: z.record(z.string(), z.number()),
              rangeFrom: z.string().nullable(),
              rangeTo: z.string().nullable(),
              status: z.enum(["accepted", "processed", "failed"]),
              error: z.string().nullable(),
              receivedAt: z.string(),
              processedAt: z.string().nullable(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "building:read", async (tx, _a, ctx) => {
        const rows = await tx
          .select()
          .from(schema.ingestionBatches)
          .where(
            and(
              eq(schema.ingestionBatches.buildingId, ctx.building.id),
              req.query.pending ? isNull(schema.ingestionBatches.processedAt) : undefined,
            ),
          )
          .orderBy(desc(schema.ingestionBatches.receivedAt))
          .limit(req.query.limit);
        return rows.map((r) => ({
          id: r.id,
          idempotencyKey: r.idempotencyKey,
          counts: r.counts,
          rangeFrom: iso(r.rangeFrom),
          rangeTo: iso(r.rangeTo),
          status: r.status,
          error: r.error,
          receivedAt: r.receivedAt.toISOString(),
          processedAt: iso(r.processedAt),
        }));
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/recompute",
    {
      schema: {
        tags: ["telemetry"],
        summary:
          "Reprocess whole days, e.g. after changing rule parameters, the tariff, leases or the calendar",
        params: buildingParams,
        body: z.object({ fromDate: dateKey, toDateExclusive: dateKey }),
        response: { 202: z.object({ batchId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const { fromDate, toDateExclusive } = req.body;
      const days = (Date.parse(toDateExclusive) - Date.parse(fromDate)) / 86_400_000;
      if (!(days >= 1 && days <= 400)) throw badRequest("Choose between 1 and 400 days.");
      const batchId = await withBuildingContext(
        db,
        req,
        req.params,
        "building:write",
        async (tx, access, ctx) => {
          if (fromDate > addDaysKey(todayIn(ctx.building.timezone), 1))
            throw unprocessable("The range starts in the future.");
          // a batch without items marks a range for the recompute job, like an ingestion batch would
          const [b] = await tx
            .insert(schema.ingestionBatches)
            .values({
              orgId: access.orgId,
              buildingId: ctx.building.id,
              idempotencyKey: `recompute-${randomToken(12)}`,
              counts: {},
              rangeFrom: new Date(zonedTime(fromDate, 0, ctx.building.timezone)),
              rangeTo: new Date(zonedTime(toDateExclusive, 0, ctx.building.timezone)),
            })
            .returning({ id: schema.ingestionBatches.id });
          await audit(tx, req, access, {
            action: "building.recompute",
            entityType: "building",
            entityId: ctx.building.id,
            data: { fromDate, toDateExclusive },
          });
          return b!.id;
        },
      );
      await jobs.recompute({ orgId: req.params.orgId, buildingId: req.params.buildingId });
      return reply.status(202).send({ batchId });
    },
  );

  // a quick health view for the building's data feed
  app.get(
    "/orgs/:orgId/buildings/:buildingId/data-health",
    {
      schema: {
        tags: ["telemetry"],
        summary: "Devices that stopped reporting and pending processing",
        params: buildingParams,
        response: {
          200: z.object({
            devices: z.number(),
            silentDevices: z.array(
              z.object({
                id: uuid,
                externalId: z.string(),
                name: z.string(),
                lastSeenAt: z.string().nullable(),
              }),
            ),
            pendingBatches: z.number(),
            failedBatches: z.number(),
            lastReceivedAt: z.string().nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "building:read", async (tx, _a, ctx) => {
        const devices = await tx
          .select()
          .from(schema.devices)
          .where(eq(schema.devices.buildingId, ctx.building.id));
        const cutoff = Date.now() - 2 * 3_600_000;
        const [stats] = await tx
          .select({
            pending: sql<number>`count(*) filter (where ${schema.ingestionBatches.processedAt} is null and ${schema.ingestionBatches.status} = 'accepted')::int`,
            failed: sql<number>`count(*) filter (where ${schema.ingestionBatches.status} = 'failed')::int`,
            last: sql<string | null>`max(${schema.ingestionBatches.receivedAt})::text`,
          })
          .from(schema.ingestionBatches)
          .where(eq(schema.ingestionBatches.buildingId, ctx.building.id));
        return {
          devices: devices.length,
          silentDevices: devices
            .filter((d) => !d.lastSeenAt || d.lastSeenAt.getTime() < cutoff)
            .map((d) => ({
              id: d.id,
              externalId: d.externalId,
              name: d.name,
              lastSeenAt: iso(d.lastSeenAt),
            })),
          pendingBatches: stats?.pending ?? 0,
          failedBatches: stats?.failed ?? 0,
          lastReceivedAt: stats?.last ? new Date(stats.last).toISOString() : null,
        };
      }),
  );
};
