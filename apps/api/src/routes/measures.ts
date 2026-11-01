import { MEASURE_STRATEGY_IDS } from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { measureFooting } from "@flowcarbon/pipeline";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { conflict, notFound, unprocessable } from "../errors";
import {
  agreeMeasure,
  coveredBy,
  type MeasureJson,
  type MeasureRow,
  measureJson,
  measureOut,
  setFindings,
  settleFindings,
  statusChange,
  takeEffectIfSimulated,
  userOf,
} from "../measures";
import { buildingParams, errorResponses, uuid } from "../schemas";
import { findingJson, findingOut } from "./analytics";
import { withBuildingContext } from "./helpers";

const measureParams = buildingParams.extend({ measureId: uuid });

export const measureRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.get(
    "/orgs/:orgId/buildings/:buildingId/measures",
    {
      schema: {
        tags: ["analytics"],
        summary: "Measures agreed for the building, newest first, each with what the data says about it",
        params: buildingParams,
        querystring: z.object({ status: z.enum(["planned", "in_effect", "cancelled"]).optional() }),
        response: {
          200: z.object({
            items: z.array(measureOut),
            totals: z.object({
              planned: z.number(),
              inEffect: z.number(),
              /** measures in effect with complete days of data since */
              measured: z.number(),
              /** measured saving per week of those, and expected saving of the rest */
              weeklyKwh: z.number(),
              weeklyCost: z.number(),
              expectedWeeklyKwh: z.number(),
              expectedWeeklyCost: z.number(),
              /** the range around `expectedWeeklyKwh`, and the days of data behind it */
              expectedWeeklyLowKwh: z.number(),
              expectedWeeklyHighKwh: z.number(),
              expectedDays: z.number(),
            }),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:read", async (tx, _a, ctx) => {
        const rows = await tx
          .select()
          .from(schema.measures)
          .where(
            and(
              eq(schema.measures.buildingId, ctx.building.id),
              req.query.status ? eq(schema.measures.status, req.query.status) : undefined,
            ),
          )
          .orderBy(desc(schema.measures.createdAt))
          .limit(200);
        const footing = await measureFooting(tx, ctx);
        const items: MeasureJson[] = [];
        for (const m of rows) items.push(await measureJson(tx, ctx, m, footing));
        // measured: in effect with complete days since; expected: planned, or in effect but not measured yet
        const measured = items.filter(
          (m) => m.status === "in_effect" && (m.verification.after?.days ?? 0) > 0,
        );
        const expected = items.filter(
          (m) => m.status === "planned" || (m.status === "in_effect" && !m.verification.after?.days),
        );
        const sum = (list: MeasureJson[], key: "kwh" | "cost") =>
          Math.round(list.reduce((s, m) => s + m.verification.weekly[key], 0) * 100) / 100;
        const range = (key: "lowKwh" | "highKwh") =>
          Math.round(expected.reduce((s, m) => s + (m.verification.expected?.[key] ?? 0), 0) * 100) / 100;
        return {
          items,
          totals: {
            planned: items.filter((m) => m.status === "planned").length,
            inEffect: items.filter((m) => m.status === "in_effect").length,
            measured: measured.length,
            weeklyKwh: sum(measured, "kwh"),
            weeklyCost: sum(measured, "cost"),
            expectedWeeklyKwh: sum(expected, "kwh"),
            expectedWeeklyCost: sum(expected, "cost"),
            expectedWeeklyLowKwh: range("lowKwh"),
            expectedWeeklyHighKwh: range("highKwh"),
            expectedDays: footing.days,
          },
        };
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/measures/:measureId",
    {
      schema: {
        tags: ["analytics"],
        summary:
          "One measure: its findings, what came back after it took effect, and the before/after comparison",
        params: measureParams,
        response: {
          200: measureOut.extend({
            linked: z.array(findingOut),
            /** covered findings on the floor since it took effect that are not linked to it */
            recurring: z.array(findingOut),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:read", async (tx, _a, ctx) => {
        const m = await loadMeasure(tx, ctx.building.id, req.params.measureId);
        const linked = await tx
          .select()
          .from(schema.findings)
          .where(eq(schema.findings.measureId, m.id))
          .orderBy(desc(schema.findings.startAt))
          .limit(200);
        const recurring =
          m.implementedAt && m.status !== "planned"
            ? await tx
                .select()
                .from(schema.findings)
                .where(
                  and(
                    eq(schema.findings.buildingId, ctx.building.id),
                    coveredBy(m),
                    ne(schema.findings.status, "dismissed"),
                    isNull(schema.findings.measureId),
                  ),
                )
                .orderBy(desc(schema.findings.startAt))
                .limit(50)
                .then((rows) => rows.filter((f) => f.startAt >= m.implementedAt!))
            : [];
        return {
          ...(await measureJson(tx, ctx, m)),
          linked: linked.map((f) => findingJson(f, m)),
          recurring: recurring.map((f) => findingJson(f)),
        };
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/findings/:findingId/measure",
    {
      schema: {
        tags: ["analytics"],
        summary:
          "Agree a measure for a finding: the AI assistant's recommendation as it stands, edited, or the team's own. Joins the floor's active measure with the same strategy if there is one; with `similar`, the floor's other open findings it covers are linked too.",
        params: buildingParams.extend({ findingId: uuid }),
        body: z.object({
          strategyId: z.enum(MEASURE_STRATEGY_IDS),
          note: z.string().trim().max(2000).optional(),
          source: z.enum(["ai", "ai_edited", "manual"]),
          explanationId: uuid.optional(),
          similar: z.boolean().default(true),
        }),
        response: {
          201: z.object({ measure: measureOut, linked: z.number(), joined: z.boolean() }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const out = await withBuildingContext(
        db,
        req,
        req.params,
        "finding:review",
        async (tx, access, ctx) => {
          const [f] = await tx
            .select()
            .from(schema.findings)
            .where(
              and(
                eq(schema.findings.id, req.params.findingId),
                eq(schema.findings.buildingId, ctx.building.id),
              ),
            );
          if (!f) throw notFound("Finding");
          if (f.measureId) {
            const [current] = await tx
              .select({ status: schema.measures.status })
              .from(schema.measures)
              .where(eq(schema.measures.id, f.measureId));
            if (current && current.status !== "cancelled")
              throw conflict("This finding already belongs to a measure. Change or cancel that one instead.");
          }
          const b = req.body;
          const [explanation] = b.explanationId
            ? await tx
                .select({ id: schema.aiExplanations.id })
                .from(schema.aiExplanations)
                .where(
                  and(
                    eq(schema.aiExplanations.id, b.explanationId),
                    eq(schema.aiExplanations.findingId, f.id),
                  ),
                )
            : [];
          const agreed = await agreeMeasure(tx, req, access, ctx.building.id, {
            finding: f,
            strategyId: b.strategyId,
            source: b.source,
            note: b.note,
            explanationId: explanation?.id,
            similar: b.similar,
          });
          const measure = await takeEffectIfSimulated(tx, req, access, agreed);
          return {
            measure: await measureJson(tx, ctx, measure),
            linked: agreed.linked.length,
            joined: agreed.joined,
          };
        },
      );
      return reply.status(201).send(out);
    },
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/measures/:measureId",
    {
      schema: {
        tags: ["analytics"],
        summary:
          "Change a measure: its note, its strategy while planned, or its status. In effect resolves its findings (and the floor's earlier open ones it covers); back to planned undoes that; cancelled reopens them.",
        params: measureParams,
        body: z
          .object({
            note: z.string().trim().max(2000).nullable().optional(),
            strategyId: z.enum(MEASURE_STRATEGY_IDS).optional(),
            status: z.enum(["planned", "in_effect", "cancelled"]).optional(),
          })
          .refine((b) => Object.keys(b).length > 0, "Nothing to change."),
        response: { 200: measureOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:review", async (tx, access, ctx) => {
        const before = await loadMeasure(tx, ctx.building.id, req.params.measureId);
        if (before.status === "cancelled")
          throw unprocessable("This measure was cancelled; agree a new one instead.");
        const b = req.body;
        if (b.strategyId && b.strategyId !== before.strategyId && before.status !== "planned")
          throw unprocessable("A measure in effect keeps its strategy; cancel it and agree a new one.");
        const now = new Date();
        const [m] = await tx
          .update(schema.measures)
          .set({
            ...(b.note !== undefined ? { note: b.note || null } : {}),
            ...(b.strategyId ? { strategyId: b.strategyId } : {}),
            ...statusChange(before.status, b.status, userOf(access), now),
          })
          .where(eq(schema.measures.id, before.id))
          .returning();
        const after = m!;
        let action = "measure.update";
        let count = 0;
        if (after.status !== before.status) {
          ({ action, count } = await settleFindings(tx, access, ctx.building.id, after, now));
        } else if (b.strategyId && b.strategyId !== before.strategyId) {
          // findings the new strategy does not cover go back to the list, except the one it was agreed from
          const keep = await tx
            .select({ id: schema.findings.id })
            .from(schema.findings)
            .where(and(eq(schema.findings.measureId, after.id), coveredBy(after)));
          const keepIds = new Set([...keep.map((k) => k.id), after.originFindingId]);
          const linked = await tx
            .select({ id: schema.findings.id })
            .from(schema.findings)
            .where(and(eq(schema.findings.measureId, after.id), eq(schema.findings.status, "acknowledged")));
          const drop = linked.map((r) => r.id).filter((id) => !keepIds.has(id));
          count = await setFindings(tx, access, drop, { status: "open", measureId: null });
        }
        await audit(tx, req, access, {
          action,
          entityType: "measure",
          entityId: after.id,
          data: {
            ...(b.note !== undefined ? { note: b.note } : {}),
            ...(b.strategyId && b.strategyId !== before.strategyId
              ? { strategyId: { from: before.strategyId, to: b.strategyId } }
              : {}),
            ...(after.status !== before.status ? { status: { from: before.status, to: after.status } } : {}),
            findings: count,
          },
        });
        return measureJson(tx, ctx, after);
      }),
  );
};

async function loadMeasure(tx: Tx, buildingId: string, id: string): Promise<MeasureRow> {
  const [m] = await tx
    .select()
    .from(schema.measures)
    .where(and(eq(schema.measures.id, id), eq(schema.measures.buildingId, buildingId)));
  if (!m) throw notFound("Measure");
  return m;
}
