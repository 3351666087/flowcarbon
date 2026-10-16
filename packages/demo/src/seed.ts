import { addDays, type HvacMode, localParts, triageOvertime } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import {
  deleteOrganization,
  type IngestBatch,
  ingestTelemetry,
  loadBuildingContext,
  MAX_BATCH_ITEMS,
  processDays,
  refreshForecasts,
} from "@flowcarbon/pipeline";
import { hashPassword } from "@flowcarbon/security";
import { type SimBuilding, sampleTower, simulate } from "@flowcarbon/sim";
import { eq, sql } from "drizzle-orm";

export type DemoRole = "owner" | "property_manager" | "energy_analyst" | "engineer" | "tenant_admin";

export interface DemoUser {
  email: string;
  name: string;
  role: DemoRole;
  /** simulator tenant id, for tenant_admin users */
  tenant?: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
  { email: "owner@flowcarbon-demo.example", name: "Demo Owner", role: "owner" },
  { email: "manager@flowcarbon-demo.example", name: "Demo Property Manager", role: "property_manager" },
  { email: "analyst@flowcarbon-demo.example", name: "Demo Energy & Carbon Analyst", role: "energy_analyst" },
  { email: "engineer@flowcarbon-demo.example", name: "Demo Energy Engineer", role: "engineer" },
  {
    email: "tenant@flowcarbon-demo.example",
    name: "Demo Tenant Admin (Northwind)",
    role: "tenant_admin",
    tenant: "t-northwind",
  },
];

export interface SeedOptions {
  slug?: string;
  orgName?: string;
  /** first simulated local date */
  startDate: string;
  days: number;
  seed?: number;
  /** password for every demo user */
  password: string;
  /** drop an existing organisation with the same slug first */
  reset?: boolean;
  /** forecast horizon after the last simulated day */
  forecastDays?: number;
  log?: (msg: string) => void;
}

export interface SeedResult {
  orgId: string;
  buildingId: string;
  floorIds: Record<string, string>;
  tenantIds: Record<string, string>;
  users: { email: string; role: DemoRole }[];
  telemetry: Record<string, number>;
  findings: number;
}

/** External ids of the devices on a simulated floor. */
export function deviceIds(floorLabel: string) {
  return {
    door: `TA-${floorLabel}-DOOR`,
    bms: `TA-${floorLabel}-AHU`,
    light: `TA-${floorLabel}-LIGHT`,
    meter: (system: string) => `TA-${floorLabel}-M-${system.toUpperCase()}`,
  };
}

/**
 * Creates a complete demonstration organisation: users, the simulated Tower A with tenants, leases and devices,
 * the simulated telemetry pushed through the same ingestion path gateways use, approved overtime requests, and
 * processed intervals, findings and forecasts. Everything is labelled as simulated.
 */
export async function seedDemo(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const slug = opts.slug ?? "tower-a-demo";
  const sb: SimBuilding = sampleTower();

  const [existing] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
  if (existing) {
    if (!opts.reset) throw new Error(`organisation ${slug} already exists; pass reset to replace it`);
    await deleteOrganization(db, existing.id);
    log(`removed existing organisation ${slug}`);
  }
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: opts.orgName ?? "Tower A Property Management (demo)", plan: "demo" })
    .returning();
  if (!org) throw new Error("organisation insert failed");

  const passwordHash = await hashPassword(opts.password);
  const userIds = new Map<string, string>();
  for (const u of DEMO_USERS) {
    const [found] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${u.email}`);
    const [row] = found
      ? [found]
      : await db
          .insert(schema.users)
          .values({ email: u.email, name: u.name, passwordHash, emailVerifiedAt: new Date() })
          .returning({ id: schema.users.id });
    if (!row) throw new Error(`user ${u.email} could not be created`);
    await db.update(schema.users).set({ passwordHash, disabledAt: null }).where(eq(schema.users.id, row.id));
    userIds.set(u.email, row.id);
  }

  const result = await withOrg(db, org.id, async (tx) => {
    const b = sb.building;
    const [building] = await tx
      .insert(schema.buildings)
      .values({
        orgId: org.id,
        name: `${b.name} (simulated)`,
        address: "Suzhou Industrial Park, Jiangsu (simulated building)",
        timezone: b.timezone,
        currency: b.currency,
        workdayStart: b.workdayStart,
        afterHoursStart: b.afterHoursStart,
        gridRegion: b.gridRegion,
        tariff: b.tariff,
      })
      .returning();
    if (!building) throw new Error("building insert failed");

    const floorIds: Record<string, string> = {};
    const floorRows = await tx
      .insert(schema.floors)
      .values(
        sb.floors.map((f) => ({
          orgId: org.id,
          buildingId: building.id,
          label: f.label,
          level: f.level,
          areaM2: f.areaM2,
          ratedHvacKw: f.ratedHvacKw,
          ratedLightingKw: f.ratedLightingKw,
          plugKwPerPerson: f.plugKwPerPerson,
          zoneOnlyFraction: f.zoneOnlyFraction ?? 0.3,
        })),
      )
      .returning();
    for (const f of sb.floors) floorIds[f.id] = floorRows.find((r) => r.label === f.label)!.id;

    const tenantIds: Record<string, string> = {};
    for (const t of sb.tenants) {
      const [row] = await tx
        .insert(schema.tenants)
        .values({
          orgId: org.id,
          buildingId: building.id,
          name: t.name,
          overtimeRatePerHour: t.overtimeRatePerHour,
          contactEmail: t.contactEmail,
        })
        .returning();
      tenantIds[t.id] = row!.id;
      for (const f of t.floors)
        await tx
          .insert(schema.leases)
          .values({ orgId: org.id, tenantId: row!.id, floorId: floorIds[f]!, startsOn: "2024-01-01" });
    }
    if (b.calendar.holidays.length || b.calendar.workdays.length)
      await tx.insert(schema.calendarDays).values([
        ...b.calendar.holidays.map((day) => ({
          orgId: org.id,
          buildingId: building.id,
          day,
          kind: "holiday" as const,
          name: "Public holiday",
        })),
        ...b.calendar.workdays.map((day) => ({
          orgId: org.id,
          buildingId: building.id,
          day,
          kind: "workday" as const,
          name: "Make-up working day",
        })),
      ]);

    const devices: (typeof schema.devices.$inferInsert)[] = sb.floors.flatMap((f) => {
      const ids = deviceIds(f.label);
      const base = { orgId: org.id, buildingId: building.id, floorId: floorIds[f.id]! };
      const list: (typeof schema.devices.$inferInsert)[] = [
        { ...base, kind: "door_counter", externalId: ids.door, name: `${f.label} door counter` },
        { ...base, kind: "bms_zone", externalId: ids.bms, name: `${f.label} AHU zone (BMS)` },
        { ...base, kind: "lighting_controller", externalId: ids.light, name: `${f.label} lighting circuits` },
      ];
      if (sb.meteredFloors.includes(f.id))
        for (const system of ["hvac", "lighting", "plug"] as const)
          list.push({
            ...base,
            kind: "meter",
            system,
            externalId: ids.meter(system),
            name: `${f.label} ${system} sub-meter`,
          });
      return list;
    });
    await tx.insert(schema.devices).values(devices);

    await tx.insert(schema.contractualInstruments).values({
      orgId: org.id,
      buildingId: building.id,
      kind: "green_certificate",
      periodStart: "2026-07-01",
      periodEnd: "2026-12-31",
      kwh: 60_000,
      kgPerKwh: 0,
      description: "Green electricity certificates (GEC), H2 2026 — simulated",
    });

    const ctx = await loadBuildingContext(tx, org.id, building.id);
    const sim = simulate(sb, { startDate: opts.startDate, days: opts.days, seed: opts.seed });
    const label = new Map(sb.floors.map((f) => [f.id, f.label]));
    const iso = (ts: number) => new Date(ts).toISOString();
    // the simulator can schedule a state change after the window (lights switched off next morning); drop it
    const inWindow = <T extends { ts: number }>(e: T) => e.ts < sim.to;
    const items = {
      readings: sim.readings.map((r) => ({
        device: deviceIds(label.get(r.floorId)!).meter(r.system),
        start: iso(r.start),
        end: iso(r.end),
        kwh: r.kwh,
      })),
      doorCounts: sim.doorCounts.map((d) => ({
        device: deviceIds(label.get(d.floorId)!).door,
        start: iso(d.start),
        entries: d.entries,
        exits: d.exits,
      })),
      hvacEvents: dedupeLast(
        sim.hvacEvents.filter(inWindow).map((e) => ({
          device: deviceIds(label.get(e.floorId)!).bms,
          at: iso(e.ts),
          mode: e.mode as HvacMode,
        })),
      ),
      lightingEvents: dedupeLast(
        sim.lightingEvents
          .filter(inWindow)
          .map((e) => ({ device: deviceIds(label.get(e.floorId)!).light, at: iso(e.ts), level: e.level })),
      ),
    };
    const telemetry: Record<string, number> = {};
    let part = 0;
    for (const key of ["readings", "doorCounts", "hvacEvents", "lightingEvents"] as const) {
      const list = items[key];
      telemetry[key] = list.length;
      for (let i = 0; i < list.length; i += MAX_BATCH_ITEMS) {
        const batch: IngestBatch = {
          readings: [],
          doorCounts: [],
          hvacEvents: [],
          lightingEvents: [],
          [key]: list.slice(i, i + MAX_BATCH_ITEMS),
        };
        await ingestTelemetry(tx, ctx, { batch, idempotencyKey: `seed-${slug}-${part++}` });
      }
    }
    log(
      `ingested ${Object.entries(telemetry)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}`,
    );

    const tenantProfile = new Map(sb.tenants.map((t) => [t.id, t]));
    const managerId = userIds.get("manager@flowcarbon-demo.example") ?? null;
    for (const o of sim.overtime) {
      const floor = sb.floors.find((f) => f.id === o.floorId)!;
      const triage = triageOvertime(o, tenantProfile.get(o.tenantId)!, floor);
      await tx.insert(schema.overtimeRequests).values({
        orgId: org.id,
        buildingId: building.id,
        tenantId: tenantIds[o.tenantId]!,
        floorId: floorIds[o.floorId]!,
        startAt: new Date(o.start),
        hours: o.hours,
        expectedPeople: o.expectedPeople,
        status: "approved",
        recommendedMode: triage.mode,
        approvedMode: triage.mode,
        fee: triage.fee,
        recommendation: triage.note,
        decidedBy: managerId,
        decidedAt: new Date(o.requestedAt + 3_600_000),
        createdAt: new Date(o.requestedAt),
      });
    }

    const endDate = addDays(opts.startDate, opts.days);
    const processed = await processDays(tx, ctx, opts.startDate, endDate);
    log(`processed ${processed.days} days: ${processed.intervals} intervals, ${processed.upserted} findings`);
    await refreshForecasts(tx, ctx, endDate, opts.forecastDays ?? 7);
    // the seed processed its own batches synchronously
    await tx
      .update(schema.ingestionBatches)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(schema.ingestionBatches.buildingId, building.id));

    for (const u of DEMO_USERS)
      await tx.insert(schema.memberships).values({
        orgId: org.id,
        userId: userIds.get(u.email)!,
        role: u.role,
        tenantId: u.tenant ? tenantIds[u.tenant]! : null,
      });
    await tx.insert(schema.auditLog).values({
      orgId: org.id,
      actorType: "system",
      action: "demo.seed",
      entityType: "organization",
      entityId: org.id,
      data: { startDate: opts.startDate, days: opts.days, seed: opts.seed ?? null },
    });
    return { buildingId: building.id, floorIds, tenantIds, telemetry, findings: processed.upserted };
  });

  return { orgId: org.id, ...result, users: DEMO_USERS.map((u) => ({ email: u.email, role: u.role })) };
}

/** Keeps the last event per device and timestamp (the simulator can emit two at the same instant). */
function dedupeLast<T extends { device: string; at: string }>(events: T[]): T[] {
  const m = new Map<string, T>();
  for (const e of events) m.set(`${e.device}|${e.at}`, e);
  return [...m.values()];
}

/** The last `days` whole local days before today in the building's time zone. */
export function recentWindow(
  days: number,
  timeZone = "Asia/Shanghai",
  now = Date.now(),
): { startDate: string; days: number } {
  const today = localParts(now, timeZone).dateKey;
  return { startDate: addDays(today, -days), days };
}
