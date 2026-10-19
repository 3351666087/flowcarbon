import { schema } from "@flowcarbon/db";
import { importCarrySchema, importRowSchema, importRows, MAX_IMPORT_ROWS } from "@flowcarbon/pipeline";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { unprocessable } from "../errors";
import { buildingParams, errorResponses } from "../schemas";
import { withBuildingContext } from "./helpers";

/**
 * Data brought in by hand, next to the live feed: a table of floor intervals (people, energy per system, cooling and
 * lighting state) uploaded from the browser in parts. Each part goes through the same ingestion path as a gateway.
 */
export const importRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs }) => {
  app.post(
    "/orgs/:orgId/buildings/:buildingId/imports",
    {
      bodyLimit: 4 * 1024 * 1024,
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["telemetry"],
        summary:
          "Import a part of a table of floor intervals (time, floor, people, kWh per system, cooling, lighting). Send parts in time order per floor and pass back the returned `carry`.",
        params: buildingParams,
        body: z.object({
          rows: z.array(importRowSchema).min(1).max(MAX_IMPORT_ROWS),
          /** where each floor stood after the previous part (from the previous response) */
          carry: importCarrySchema.optional(),
          /** identifies this part, so a retried request is not imported twice */
          key: z.string().min(8).max(80),
          /** the file it came from, for the audit log */
          source: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({
            rows: z.number(),
            skipped: z.object({
              unknownFloor: z.number(),
              badTime: z.number(),
              unknownFloors: z.array(z.string()),
            }),
            counts: z.record(z.string(), z.number()),
            carry: importCarrySchema,
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const out = await withBuildingContext(
        db,
        req,
        req.params,
        "telemetry:write",
        async (tx, access, ctx) => {
          const [org] = await tx
            .select({ plan: schema.organizations.plan })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, access.orgId));
          if (org?.plan === "demo")
            throw unprocessable(
              "A demo building runs on simulated data. Import into an organisation of your own instead.",
            );
          const r = await importRows(tx, ctx, {
            rows: req.body.rows,
            carry: req.body.carry,
            key: req.body.key,
          });
          await audit(tx, req, access, {
            action: "building.import",
            entityType: "building",
            entityId: ctx.building.id,
            data: { source: req.body.source ?? null, rows: r.rows, skipped: r.skipped, counts: r.counts },
          });
          return r;
        },
      );
      if (out.batches.some((b) => !b.duplicate))
        await jobs.recompute({ orgId: req.params.orgId, buildingId: req.params.buildingId });
      return { rows: out.rows, skipped: out.skipped, counts: out.counts, carry: out.carry };
    },
  );
};
