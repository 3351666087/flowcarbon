import { triageOvertime, validateOvertimeRequest, zonedTime } from "@flowcarbon/core";
import { schema } from "@flowcarbon/db";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { visibleFloorIds } from "../auth/access";
import { conflict, forbidden, notFound, unprocessable } from "../errors";
import { buildingParams, dateKey, errorResponses, iso, timestamp, uuid } from "../schemas";
import { todayIn, withBuildingContext } from "./helpers";

const status = z.enum(["requested", "approved", "declined", "cancelled"]);
const requestOut = z.object({
  id: uuid,
  tenantId: uuid,
  floorId: uuid,
  startAt: z.string(),
  hours: z.number(),
  expectedPeople: z.number(),
  status,
  recommendedMode: z.enum(["off", "setback", "full"]),
  approvedMode: z.enum(["off", "setback", "full"]).nullable(),
  fee: z.number(),
  recommendation: z.string(),
  decisionNote: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
type Row = typeof schema.overtimeRequests.$inferSelect;
const json = (r: Row) => ({
  id: r.id,
  tenantId: r.tenantId,
  floorId: r.floorId,
  startAt: r.startAt.toISOString(),
  hours: r.hours,
  expectedPeople: r.expectedPeople,
  status: r.status,
  recommendedMode: r.recommendedMode,
  approvedMode: r.approvedMode,
  fee: r.fee,
  recommendation: r.recommendation,
  decisionNote: r.decisionNote,
  decidedAt: iso(r.decidedAt),
  createdAt: r.createdAt.toISOString(),
});

export const overtimeRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs }) => {
  app.get(
    "/orgs/:orgId/buildings/:buildingId/overtime-requests",
    {
      schema: {
        tags: ["overtime"],
        summary: "After-hours cooling requests. Tenant admins see only their own tenant's.",
        params: buildingParams,
        querystring: z.object({
          status: status.optional(),
          from: dateKey.optional(),
          to: dateKey.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.array(requestOut), ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "overtime:read", async (tx, access, ctx) => {
        const tz = ctx.building.timezone;
        const rows = await tx
          .select()
          .from(schema.overtimeRequests)
          .where(
            and(
              eq(schema.overtimeRequests.buildingId, ctx.building.id),
              access.tenantId ? eq(schema.overtimeRequests.tenantId, access.tenantId) : undefined,
              req.query.status ? eq(schema.overtimeRequests.status, req.query.status) : undefined,
              req.query.from
                ? gte(schema.overtimeRequests.startAt, new Date(zonedTime(req.query.from, 0, tz)))
                : undefined,
              req.query.to
                ? lt(schema.overtimeRequests.startAt, new Date(zonedTime(req.query.to, 0, tz)))
                : undefined,
            ),
          )
          .orderBy(desc(schema.overtimeRequests.startAt))
          .limit(req.query.limit);
        return rows.map(json);
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/overtime-requests",
    {
      schema: {
        tags: ["overtime"],
        summary:
          "Request after-hours cooling for one leased floor; the system suggests full floor or zone setback",
        params: buildingParams,
        body: z.object({
          floorId: uuid,
          startAt: timestamp,
          hours: z.number().positive().max(16),
          expectedPeople: z.number().int().min(1).max(5_000),
          tenantId: uuid.optional(),
        }),
        response: { 201: requestOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const row = await withBuildingContext(
        db,
        req,
        req.params,
        "overtime:request",
        async (tx, access, ctx) => {
          // tenant admins always request for their own tenant; staff name the tenant (default: the floor's tenant)
          const tenantId = access.tenantId ?? req.body.tenantId ?? ctx.floorTenant.get(req.body.floorId);
          if (!tenantId) throw unprocessable("The floor is not leased; name the tenant.");
          if (access.tenantId && req.body.tenantId && req.body.tenantId !== access.tenantId)
            throw forbidden("You can only request for your own tenant.");
          const tenant = ctx.tenants.find((t) => t.id === tenantId);
          const floor = ctx.floors.find((f) => f.id === req.body.floorId);
          if (!tenant || !floor) throw notFound("Tenant or floor");
          const tenantFloors = [...ctx.floorTenant].filter(([, t]) => t === tenantId).map(([f]) => f);
          const input = {
            tenantId,
            floorId: floor.id,
            start: Date.parse(req.body.startAt),
            hours: req.body.hours,
            expectedPeople: req.body.expectedPeople,
          };
          const problems = validateOvertimeRequest(input, { tenantFloors, now: Date.now() });
          if (problems.length) throw unprocessable("The request is not valid.", problems);
          const end = new Date(input.start + input.hours * 3_600_000);
          const clash = await tx
            .select({ id: schema.overtimeRequests.id })
            .from(schema.overtimeRequests)
            .where(
              and(
                eq(schema.overtimeRequests.floorId, floor.id),
                eq(schema.overtimeRequests.status, "requested"),
                lt(schema.overtimeRequests.startAt, end),
                gte(schema.overtimeRequests.startAt, new Date(input.start - 16 * 3_600_000)),
              ),
            );
          if (clash.length)
            throw conflict("There is already an open request for this floor around that time.");
          const fullFloorMinPeople = Number(ctx.ruleParams.fullFloorMinPeople ?? 3);
          const triage = triageOvertime(input, tenant, floor, fullFloorMinPeople);
          const [r] = await tx
            .insert(schema.overtimeRequests)
            .values({
              orgId: access.orgId,
              buildingId: ctx.building.id,
              tenantId,
              floorId: floor.id,
              startAt: new Date(input.start),
              hours: input.hours,
              expectedPeople: input.expectedPeople,
              recommendedMode: triage.mode,
              fee: triage.fee,
              recommendation: triage.note,
              requestedBy: access.actor.type === "user" ? access.actor.id : null,
            })
            .returning();
          await audit(tx, req, access, {
            action: "overtime.request",
            entityType: "overtime_request",
            entityId: r!.id,
            data: { ...req.body, fee: triage.fee },
          });
          return r!;
        },
      );
      return reply.status(201).send(json(row));
    },
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/overtime-requests/:requestId/decision",
    {
      schema: {
        tags: ["overtime"],
        summary: "Approve (full floor or setback) or decline a request",
        params: buildingParams.extend({ requestId: uuid }),
        body: z.object({
          decision: z.enum(["approve", "decline"]),
          mode: z.enum(["setback", "full"]).optional(),
          note: z.string().trim().max(1000).optional(),
        }),
        response: { 200: requestOut, ...errorResponses },
      },
    },
    async (req) => {
      const { row, changed } = await withBuildingContext(
        db,
        req,
        req.params,
        "overtime:decide",
        async (tx, access, ctx) => {
          const [before] = await tx
            .select()
            .from(schema.overtimeRequests)
            .where(
              and(
                eq(schema.overtimeRequests.id, req.params.requestId),
                eq(schema.overtimeRequests.buildingId, ctx.building.id),
              ),
            )
            .for("update");
          if (!before) throw notFound("Request");
          if (before.status !== "requested") throw conflict(`The request is already ${before.status}.`);
          if (req.body.decision === "decline" && !req.body.note)
            throw unprocessable("Say why the request is declined.");
          const approve = req.body.decision === "approve";
          const [r] = await tx
            .update(schema.overtimeRequests)
            .set({
              status: approve ? "approved" : "declined",
              approvedMode: approve ? (req.body.mode ?? before.recommendedMode) : null,
              decisionNote: req.body.note ?? null,
              decidedBy: access.actor.type === "user" ? access.actor.id : null,
              decidedAt: new Date(),
            })
            .where(eq(schema.overtimeRequests.id, before.id))
            .returning();
          await audit(tx, req, access, {
            action: `overtime.${req.body.decision}`,
            entityType: "overtime_request",
            entityId: before.id,
            data: req.body,
          });
          // an approval made after the fact changes which after-hours use counts as waste
          const past = before.startAt.getTime() < Date.now();
          if (approve && past) {
            await tx
              .insert(schema.ingestionBatches)
              .values({
                orgId: access.orgId,
                buildingId: ctx.building.id,
                idempotencyKey: `overtime-${before.id}`,
                counts: {},
                rangeFrom: before.startAt,
                rangeTo: new Date(before.startAt.getTime() + before.hours * 3_600_000),
              })
              .onConflictDoNothing();
          }
          return { row: r!, changed: approve && past };
        },
      );
      if (changed) await jobs.recompute({ orgId: req.params.orgId, buildingId: req.params.buildingId });
      return json(row);
    },
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/overtime-requests/:requestId/cancel",
    {
      schema: {
        tags: ["overtime"],
        summary: "Cancel an open or approved request that has not started",
        params: buildingParams.extend({ requestId: uuid }),
        response: { 200: requestOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "overtime:request", async (tx, access, ctx) => {
        const visible = await visibleFloorIds(tx, access, ctx.building.id, todayIn(ctx.building.timezone));
        const [before] = await tx
          .select()
          .from(schema.overtimeRequests)
          .where(
            and(
              eq(schema.overtimeRequests.id, req.params.requestId),
              eq(schema.overtimeRequests.buildingId, ctx.building.id),
            ),
          )
          .for("update");
        if (
          !before ||
          (access.tenantId && before.tenantId !== access.tenantId) ||
          (visible && !visible.has(before.floorId))
        )
          throw notFound("Request");
        if (before.status === "declined" || before.status === "cancelled")
          throw conflict(`The request is already ${before.status}.`);
        if (before.startAt.getTime() <= Date.now()) throw conflict("The requested period has started.");
        const [r] = await tx
          .update(schema.overtimeRequests)
          .set({ status: "cancelled" })
          .where(eq(schema.overtimeRequests.id, before.id))
          .returning();
        await audit(tx, req, access, {
          action: "overtime.cancel",
          entityType: "overtime_request",
          entityId: before.id,
        });
        return json(r!);
      }),
  );
};
