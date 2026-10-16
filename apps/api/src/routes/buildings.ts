import { validateTariff } from "@flowcarbon/core";
import { schema, withOrg } from "@flowcarbon/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { requireOrg } from "../auth/access";
import { notFound, unprocessable } from "../errors";
import {
  buildingParams,
  clock,
  dateKey,
  errorResponses,
  iso,
  orgParams,
  ruleParamsSchema,
  tariffSchema,
  uuid,
} from "../schemas";
import { inBuilding } from "./helpers";

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown IANA time zone");

const buildingBody = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(300).nullable().optional(),
  timezone: timeZone,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("CNY"),
  workdayStart: clock.default("08:00"),
  afterHoursStart: clock.default("18:00"),
  gridRegion: z.string().regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,16}){0,3}$/),
  tariff: tariffSchema,
  ruleParams: ruleParamsSchema.default({}),
  bucketMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
});

const buildingOut = z.object({
  id: uuid,
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  workdayStart: z.string(),
  afterHoursStart: z.string(),
  gridRegion: z.string(),
  tariff: tariffSchema,
  ruleParams: ruleParamsSchema,
  bucketMinutes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const floorBody = z.object({
  label: z.string().trim().min(1).max(20),
  level: z.number().int().min(-10).max(300),
  areaM2: z.number().positive().max(1_000_000),
  ratedHvacKw: z.number().min(0).max(100_000),
  ratedLightingKw: z.number().min(0).max(100_000),
  plugKwPerPerson: z.number().min(0).max(5).default(0.12),
  zoneOnlyFraction: z.number().min(0).max(1).default(0.3),
});
const floorOut = floorBody.extend({ id: uuid, tenantId: uuid.nullable() });

const tenantBody = z.object({
  name: z.string().trim().min(1).max(160),
  overtimeRatePerHour: z.number().min(0).max(1_000_000),
  contactEmail: z.email().max(320).nullable().optional(),
});
const tenantOut = tenantBody.extend({ id: uuid, contactEmail: z.string().nullable() });

const leaseBody = z.object({
  tenantId: uuid,
  floorId: uuid,
  startsOn: dateKey,
  endsOn: dateKey.nullable().optional(),
});
const leaseOut = z.object({
  id: uuid,
  tenantId: uuid,
  floorId: uuid,
  startsOn: z.string(),
  endsOn: z.string().nullable(),
});

const deviceBody = z.object({
  floorId: uuid.nullable(),
  kind: z.enum(["meter", "door_counter", "bms_zone", "lighting_controller"]),
  system: z.enum(["hvac", "lighting", "plug", "total"]).nullable().optional(),
  externalId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(160),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const deviceOut = deviceBody.extend({
  id: uuid,
  system: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});

const calendarDay = z.object({
  day: dateKey,
  kind: z.enum(["holiday", "workday"]),
  name: z.string().nullable(),
});

const instrumentBody = z.object({
  kind: z.enum(["green_certificate", "ppa", "green_tariff", "onsite_renewable"]),
  periodStart: dateKey,
  periodEnd: dateKey,
  kwh: z.number().positive().max(1e10),
  kgPerKwh: z.number().min(0).max(2).default(0),
  description: z.string().trim().max(300).nullable().optional(),
});
const instrumentOut = instrumentBody.extend({ id: uuid, description: z.string().nullable() });

function buildingJson(b: typeof schema.buildings.$inferSelect) {
  return {
    id: b.id,
    name: b.name,
    address: b.address,
    timezone: b.timezone,
    currency: b.currency,
    workdayStart: b.workdayStart,
    afterHoursStart: b.afterHoursStart,
    gridRegion: b.gridRegion,
    tariff: b.tariff,
    ruleParams: b.ruleParams,
    bucketMinutes: b.bucketMinutes,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

function checkTariff(t: z.infer<typeof tariffSchema> | undefined) {
  if (!t) return;
  const problems = validateTariff(t);
  if (problems.length) throw unprocessable("The tariff is not valid.", problems);
}

export const buildingRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.get(
    "/orgs/:orgId/buildings",
    {
      schema: {
        tags: ["portfolio"],
        summary: "List buildings",
        params: orgParams,
        response: { 200: z.array(buildingOut), ...errorResponses },
      },
    },
    async (req) => {
      const access = await requireOrg(db, req, req.params.orgId, "building:read");
      const rows = await withOrg(db, req.params.orgId, (tx) =>
        tx
          .select()
          .from(schema.buildings)
          .where(
            and(
              sql`${schema.buildings.archivedAt} is null`,
              access.buildingId ? eq(schema.buildings.id, access.buildingId) : undefined,
            ),
          )
          .orderBy(schema.buildings.name),
      );
      return rows.map(buildingJson);
    },
  );

  app.post(
    "/orgs/:orgId/buildings",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Create a building",
        params: orgParams,
        body: buildingBody,
        response: { 201: buildingOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "building:write");
      checkTariff(req.body.tariff);
      const row = await withOrg(db, req.params.orgId, async (tx) => {
        const [b] = await tx
          .insert(schema.buildings)
          .values({ ...req.body, address: req.body.address ?? null, orgId: req.params.orgId })
          .returning();
        await audit(tx, req, access, {
          action: "building.create",
          entityType: "building",
          entityId: b!.id,
          data: { name: b!.name },
        });
        return b!;
      });
      return reply.status(201).send(buildingJson(row));
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Get a building",
        params: buildingParams,
        response: { 200: buildingOut, ...errorResponses },
      },
    },
    async (req) => inBuilding(db, req, req.params, "building:read", async (_tx, _a, b) => buildingJson(b)),
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId",
    {
      schema: {
        tags: ["portfolio"],
        summary:
          "Update a building. Rule and tariff changes apply to data processed afterwards; use /recompute to reprocess history.",
        params: buildingParams,
        body: buildingBody.partial().extend({ archived: z.boolean().optional() }),
        response: { 200: buildingOut, ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:write", async (tx, access, before) => {
        checkTariff(req.body.tariff);
        const { archived, ...fields } = req.body;
        const [b] = await tx
          .update(schema.buildings)
          .set({
            ...fields,
            ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
            updatedAt: new Date(),
          })
          .where(eq(schema.buildings.id, before.id))
          .returning();
        const changed = Object.fromEntries(
          Object.entries(req.body).map(([k, v]) => [
            k,
            { from: (before as Record<string, unknown>)[k] ?? null, to: v },
          ]),
        );
        await audit(tx, req, access, {
          action: "building.update",
          entityType: "building",
          entityId: before.id,
          data: changed,
        });
        return buildingJson(b!);
      }),
  );

  // ---- floors --------------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/floors",
    {
      schema: {
        tags: ["portfolio"],
        summary: "List floors with their current tenant",
        params: buildingParams,
        response: { 200: z.array(floorOut), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:read", async (tx, _a, b) => {
        const today = new Date().toISOString().slice(0, 10);
        const rows = await tx
          .select({
            floor: schema.floors,
            tenantId: sql<
              string | null
            >`(select l.tenant_id from leases l where l.floor_id = ${schema.floors.id} and l.starts_on <= ${today} and (l.ends_on is null or l.ends_on >= ${today}) order by l.starts_on desc limit 1)`,
          })
          .from(schema.floors)
          .where(eq(schema.floors.buildingId, b.id))
          .orderBy(schema.floors.level);
        return rows.map(({ floor: f, tenantId }) => ({
          id: f.id,
          label: f.label,
          level: f.level,
          areaM2: f.areaM2,
          ratedHvacKw: f.ratedHvacKw,
          ratedLightingKw: f.ratedLightingKw,
          plugKwPerPerson: f.plugKwPerPerson,
          zoneOnlyFraction: f.zoneOnlyFraction,
          tenantId,
        }));
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/floors",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Add a floor",
        params: buildingParams,
        body: floorBody,
        response: { 201: floorOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const row = await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        const [f] = await tx
          .insert(schema.floors)
          .values({ ...req.body, orgId: access.orgId, buildingId: b.id })
          .returning();
        await audit(tx, req, access, {
          action: "floor.create",
          entityType: "floor",
          entityId: f!.id,
          data: req.body,
        });
        return f!;
      });
      return reply.status(201).send({ ...req.body, id: row.id, tenantId: null });
    },
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/floors/:floorId",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Update a floor",
        params: buildingParams.extend({ floorId: uuid }),
        body: floorBody.partial(),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        const done = await tx
          .update(schema.floors)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(schema.floors.id, req.params.floorId), eq(schema.floors.buildingId, b.id)))
          .returning({ id: schema.floors.id });
        if (!done.length) throw notFound("Floor");
        await audit(tx, req, access, {
          action: "floor.update",
          entityType: "floor",
          entityId: req.params.floorId,
          data: req.body,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- tenants and leases --------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/tenants",
    {
      schema: {
        tags: ["portfolio"],
        summary: "List tenants with their leases",
        params: buildingParams,
        response: { 200: z.array(tenantOut.extend({ leases: z.array(leaseOut) })), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:read", async (tx, access, b) => {
        const tenants = await tx
          .select()
          .from(schema.tenants)
          .where(
            and(
              eq(schema.tenants.buildingId, b.id),
              access.tenantId ? eq(schema.tenants.id, access.tenantId) : undefined,
            ),
          )
          .orderBy(schema.tenants.name);
        const leases = await tx
          .select({ lease: schema.leases })
          .from(schema.leases)
          .innerJoin(schema.floors, eq(schema.floors.id, schema.leases.floorId))
          .where(eq(schema.floors.buildingId, b.id));
        return tenants.map((t) => ({
          id: t.id,
          name: t.name,
          overtimeRatePerHour: t.overtimeRatePerHour,
          contactEmail: t.contactEmail,
          leases: leases
            .filter((l) => l.lease.tenantId === t.id)
            .map(({ lease: l }) => ({
              id: l.id,
              tenantId: l.tenantId,
              floorId: l.floorId,
              startsOn: l.startsOn,
              endsOn: l.endsOn,
            })),
        }));
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/tenants",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Add a tenant",
        params: buildingParams,
        body: tenantBody,
        response: { 201: tenantOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        const [row] = await tx
          .insert(schema.tenants)
          .values({
            ...req.body,
            contactEmail: req.body.contactEmail ?? null,
            orgId: access.orgId,
            buildingId: b.id,
          })
          .returning();
        await audit(tx, req, access, {
          action: "tenant.create",
          entityType: "tenant",
          entityId: row!.id,
          data: { name: row!.name },
        });
        return row!;
      });
      return reply.status(201).send({
        id: t.id,
        name: t.name,
        overtimeRatePerHour: t.overtimeRatePerHour,
        contactEmail: t.contactEmail,
      });
    },
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/tenants/:tenantId",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Update a tenant",
        params: buildingParams.extend({ tenantId: uuid }),
        body: tenantBody.partial(),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        const done = await tx
          .update(schema.tenants)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(schema.tenants.id, req.params.tenantId), eq(schema.tenants.buildingId, b.id)))
          .returning({ id: schema.tenants.id });
        if (!done.length) throw notFound("Tenant");
        await audit(tx, req, access, {
          action: "tenant.update",
          entityType: "tenant",
          entityId: req.params.tenantId,
          data: req.body,
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/leases",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Lease a floor to a tenant",
        params: buildingParams,
        body: leaseBody,
        response: { 201: leaseOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const { tenantId, floorId, startsOn, endsOn } = req.body;
      if (endsOn && endsOn < startsOn) throw unprocessable("A lease cannot end before it starts.");
      const lease = await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        const [t] = await tx
          .select()
          .from(schema.tenants)
          .where(and(eq(schema.tenants.id, tenantId), eq(schema.tenants.buildingId, b.id)));
        const [f] = await tx
          .select()
          .from(schema.floors)
          .where(and(eq(schema.floors.id, floorId), eq(schema.floors.buildingId, b.id)));
        if (!t || !f) throw unprocessable("Tenant and floor must belong to this building.");
        // a floor has at most one tenant on any day
        const overlap = await tx
          .select({ id: schema.leases.id })
          .from(schema.leases)
          .where(
            and(
              eq(schema.leases.floorId, floorId),
              sql`daterange(${schema.leases.startsOn}, coalesce(${schema.leases.endsOn}, 'infinity'::date), '[]') && daterange(${startsOn}::date, coalesce(${endsOn ?? null}::date, 'infinity'::date), '[]')`,
            ),
          );
        if (overlap.length) throw unprocessable("The floor is already leased for part of this period.");
        const [l] = await tx
          .insert(schema.leases)
          .values({ orgId: access.orgId, tenantId, floorId, startsOn, endsOn: endsOn ?? null })
          .returning();
        await audit(tx, req, access, {
          action: "lease.create",
          entityType: "lease",
          entityId: l!.id,
          data: req.body,
        });
        return l!;
      });
      return reply.status(201).send({
        id: lease.id,
        tenantId: lease.tenantId,
        floorId: lease.floorId,
        startsOn: lease.startsOn,
        endsOn: lease.endsOn,
      });
    },
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/leases/:leaseId",
    {
      schema: {
        tags: ["portfolio"],
        summary: "End or change a lease",
        params: buildingParams.extend({ leaseId: uuid }),
        body: z.object({ endsOn: dateKey.nullable() }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "building:write", async (tx, access) => {
        const [l] = await tx.select().from(schema.leases).where(eq(schema.leases.id, req.params.leaseId));
        if (!l) throw notFound("Lease");
        if (req.body.endsOn && req.body.endsOn < l.startsOn)
          throw unprocessable("A lease cannot end before it starts.");
        await tx.update(schema.leases).set({ endsOn: req.body.endsOn }).where(eq(schema.leases.id, l.id));
        await audit(tx, req, access, {
          action: "lease.update",
          entityType: "lease",
          entityId: l.id,
          data: { endsOn: { from: l.endsOn, to: req.body.endsOn } },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- devices -------------------------------------------------------------------------------------------
  const deviceJson = (d: typeof schema.devices.$inferSelect) => ({
    id: d.id,
    floorId: d.floorId,
    kind: d.kind,
    system: d.system,
    externalId: d.externalId,
    name: d.name,
    metadata: d.metadata,
    lastSeenAt: iso(d.lastSeenAt),
    createdAt: d.createdAt.toISOString(),
  });

  app.get(
    "/orgs/:orgId/buildings/:buildingId/devices",
    {
      schema: {
        tags: ["portfolio"],
        summary: "List devices and when each last reported",
        params: buildingParams,
        response: { 200: z.array(deviceOut), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:read", async (tx, _a, b) =>
        (
          await tx
            .select()
            .from(schema.devices)
            .where(eq(schema.devices.buildingId, b.id))
            .orderBy(schema.devices.externalId)
        ).map(deviceJson),
      ),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/devices",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Register a device",
        params: buildingParams,
        body: deviceBody,
        response: { 201: deviceOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const { kind, system, floorId } = req.body;
      if (kind === "meter" && !system) throw unprocessable("A meter needs the system it measures.");
      if (kind !== "meter" && system) throw unprocessable("Only meters have a system.");
      const d = await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        if (floorId) {
          const [f] = await tx
            .select()
            .from(schema.floors)
            .where(and(eq(schema.floors.id, floorId), eq(schema.floors.buildingId, b.id)));
          if (!f) throw unprocessable("The floor does not belong to this building.");
        }
        const [row] = await tx
          .insert(schema.devices)
          .values({ ...req.body, system: system ?? null, orgId: access.orgId, buildingId: b.id })
          .returning();
        await audit(tx, req, access, {
          action: "device.create",
          entityType: "device",
          entityId: row!.id,
          data: { externalId: row!.externalId, kind },
        });
        return row!;
      });
      return reply.status(201).send(deviceJson(d));
    },
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/devices/:deviceId",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Rename or reassign a device",
        params: buildingParams.extend({ deviceId: uuid }),
        body: z.object({
          name: z.string().trim().min(1).max(160).optional(),
          floorId: uuid.nullable().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
        response: { 200: deviceOut, ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        if (req.body.floorId) {
          const [f] = await tx
            .select()
            .from(schema.floors)
            .where(and(eq(schema.floors.id, req.body.floorId), eq(schema.floors.buildingId, b.id)));
          if (!f) throw unprocessable("The floor does not belong to this building.");
        }
        const [d] = await tx
          .update(schema.devices)
          .set(req.body)
          .where(and(eq(schema.devices.id, req.params.deviceId), eq(schema.devices.buildingId, b.id)))
          .returning();
        if (!d) throw notFound("Device");
        await audit(tx, req, access, {
          action: "device.update",
          entityType: "device",
          entityId: d.id,
          data: req.body,
        });
        return deviceJson(d);
      }),
  );

  // ---- calendar ------------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/calendar",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Public holidays and make-up working days",
        params: buildingParams,
        querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
        response: { 200: z.array(calendarDay), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "building:read", async (tx, _a, b) => {
        const y = req.query.year;
        const rows = await tx
          .select()
          .from(schema.calendarDays)
          .where(
            and(
              eq(schema.calendarDays.buildingId, b.id),
              y ? gte(schema.calendarDays.day, `${y}-01-01`) : undefined,
              y ? lt(schema.calendarDays.day, `${y + 1}-01-01`) : undefined,
            ),
          )
          .orderBy(schema.calendarDays.day);
        return rows.map((r) => ({ day: r.day, kind: r.kind, name: r.name }));
      }),
  );

  app.put(
    "/orgs/:orgId/buildings/:buildingId/calendar",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Replace the calendar entries of one year",
        params: buildingParams,
        body: z.object({ year: z.number().int().min(2000).max(2100), days: z.array(calendarDay).max(366) }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const { year, days } = req.body;
      if (days.some((d) => !d.day.startsWith(`${year}-`)))
        throw unprocessable(`All days must fall in ${year}.`);
      if (new Set(days.map((d) => d.day)).size !== days.length) throw unprocessable("A day appears twice.");
      await inBuilding(db, req, req.params, "building:write", async (tx, access, b) => {
        await tx
          .delete(schema.calendarDays)
          .where(
            and(
              eq(schema.calendarDays.buildingId, b.id),
              gte(schema.calendarDays.day, `${year}-01-01`),
              lt(schema.calendarDays.day, `${year + 1}-01-01`),
            ),
          );
        if (days.length)
          await tx
            .insert(schema.calendarDays)
            .values(days.map((d) => ({ ...d, orgId: access.orgId, buildingId: b.id })));
        await audit(tx, req, access, {
          action: "calendar.replace",
          entityType: "building",
          entityId: b.id,
          data: { year, days: days.length },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- contractual instruments ---------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/instruments",
    {
      schema: {
        tags: ["carbon"],
        summary: "Green certificates, PPAs and other contractual instruments",
        params: buildingParams,
        response: { 200: z.array(instrumentOut), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "report:read", async (tx, _a, b) =>
        (
          await tx
            .select()
            .from(schema.contractualInstruments)
            .where(eq(schema.contractualInstruments.buildingId, b.id))
            .orderBy(schema.contractualInstruments.periodStart)
        ).map((r) => ({
          id: r.id,
          kind: r.kind,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          kwh: r.kwh,
          kgPerKwh: r.kgPerKwh,
          description: r.description,
        })),
      ),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/instruments",
    {
      schema: {
        tags: ["carbon"],
        summary: "Record a contractual instrument",
        params: buildingParams,
        body: instrumentBody,
        response: { 201: instrumentOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      if (req.body.periodEnd < req.body.periodStart) throw unprocessable("The period ends before it starts.");
      const r = await inBuilding(db, req, req.params, "factor:write", async (tx, access, b) => {
        const [row] = await tx
          .insert(schema.contractualInstruments)
          .values({
            ...req.body,
            description: req.body.description ?? null,
            orgId: access.orgId,
            buildingId: b.id,
          })
          .returning();
        await audit(tx, req, access, {
          action: "instrument.create",
          entityType: "contractual_instrument",
          entityId: row!.id,
          data: req.body,
        });
        return row!;
      });
      return reply.status(201).send({
        id: r.id,
        kind: r.kind,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        kwh: r.kwh,
        kgPerKwh: r.kgPerKwh,
        description: r.description,
      });
    },
  );

  app.delete(
    "/orgs/:orgId/buildings/:buildingId/instruments/:instrumentId",
    {
      schema: {
        tags: ["carbon"],
        summary: "Delete a contractual instrument",
        params: buildingParams.extend({ instrumentId: uuid }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "factor:write", async (tx, access, b) => {
        const gone = await tx
          .delete(schema.contractualInstruments)
          .where(
            and(
              eq(schema.contractualInstruments.id, req.params.instrumentId),
              eq(schema.contractualInstruments.buildingId, b.id),
            ),
          )
          .returning();
        if (!gone.length) throw notFound("Instrument");
        await audit(tx, req, access, {
          action: "instrument.delete",
          entityType: "contractual_instrument",
          entityId: req.params.instrumentId,
          data: gone[0] as never,
        });
      });
      return reply.status(204).send(null);
    },
  );
};
