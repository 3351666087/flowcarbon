/**
 * Integration tests against a real PostgreSQL + TimescaleDB server.
 * Set TEST_DATABASE_URL to a superuser/owner URL (any database on the server); each run creates and drops
 * its own database. The application role `flowcarbon_app` must exist (infra/postgres/init).
 */
import {
  buildFloorIntervals,
  buildReport,
  detectFindings,
  type EmissionFactor,
  occupancyFromDoorCounts,
} from "@flowcarbon/core";
import { createDb, type DbHandle, schema, type Tx, withOrg } from "@flowcarbon/db";
import {
  buildingReport,
  deleteOrganization,
  floorsNow,
  IngestValidationError,
  ingestTelemetry,
  loadBuildingContext,
  processDays,
  strategySummary,
} from "@flowcarbon/pipeline";
import { approvedWindows, sampleTower, simulate } from "@flowcarbon/sim";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceIds, type SeedResult, seedDemo } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const adminUrl = process.env.TEST_DATABASE_URL;
const START = "2026-09-15";
const DAYS = 28;

describe.skipIf(!adminUrl)("database integration", () => {
  let tdb: TestDatabase;
  let owner: DbHandle;
  let app: DbHandle;
  let seeded: SeedResult;
  let otherOrg: { orgId: string; buildingId: string };

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    owner = createDb(tdb.ownerUrl, { max: 2 });
    app = createDb(tdb.appUrl, { max: 4 });

    // everything below runs as the non-privileged runtime role, so row-level security is in force
    seeded = await seedDemo(app.db, { startDate: START, days: DAYS, password: "integration-test-password" });
    const [org] = await app.db
      .insert(schema.organizations)
      .values({ slug: "other-org", name: "Other organisation" })
      .returning();
    const buildingId = await withOrg(app.db, org!.id, async (tx) => {
      const [b] = await tx
        .insert(schema.buildings)
        .values({
          orgId: org!.id,
          name: "Other building",
          timezone: "Asia/Shanghai",
          gridRegion: "CN-East",
          tariff: { kind: "flat", rate: 1 },
        })
        .returning();
      await tx.insert(schema.devices).values({
        orgId: org!.id,
        buildingId: b!.id,
        kind: "door_counter",
        externalId: "OTHER-DOOR",
        name: "door",
      });
      return b!.id;
    });
    otherOrg = { orgId: org!.id, buildingId };
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.drop();
  });

  const ctxA = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(app.db, seeded.orgId, fn);

  it("stores the simulated tower with TimescaleDB hypertables and RLS enabled", async () => {
    const hyper = await owner.db.execute<{ hypertable_name: string }>(
      sql`select hypertable_name from timescaledb_information.hypertables`,
    );
    expect(hyper.map((h) => h.hypertable_name).sort()).toEqual([
      "door_counts",
      "energy_readings",
      "floor_intervals",
      "hvac_events",
      "lighting_events",
    ]);
    const counts = await ctxA(async (tx) => ({
      floors: (await tx.select().from(schema.floors)).length,
      devices: (await tx.select().from(schema.devices)).length,
      forecasts: (await tx.select().from(schema.forecasts)).length,
    }));
    expect(counts).toEqual({ floors: 12, devices: 12 * 3 + 6 * 3, forecasts: 12 * 7 });
  });

  it("matches the in-memory engine exactly", async () => {
    const sb = sampleTower();
    const sim = simulate(sb, { startDate: START, days: DAYS });
    const occ = occupancyFromDoorCounts(sim.doorCounts, { timeZone: sb.building.timezone });
    const intervals = buildFloorIntervals({
      floors: sb.floors,
      from: sim.from,
      to: sim.to,
      readings: sim.readings,
      hvacEvents: sim.hvacEvents,
      lightingEvents: sim.lightingEvents.filter((e) => e.ts < sim.to),
      occupancy: [...occ].flatMap(([floorId, pts]) =>
        pts.map((p) => ({ floorId, ts: p.start, count: p.count })),
      ),
    });
    const findings = detectFindings({
      building: sb.building,
      floors: sb.floors,
      intervals,
      approvedOvertime: approvedWindows(sim.overtime),
    });
    const factor: EmissionFactor = {
      id: "x",
      region: "CN-East",
      year: 2023,
      method: "location",
      kgPerKwh: 0.55,
      source: "x",
      status: "verified",
    };
    const expected = buildReport({
      building: sb.building,
      floors: sb.floors,
      intervals,
      findings,
      locationFactor: factor,
      from: sim.from,
      to: sim.to,
    });

    const actual = await ctxA(async (tx) =>
      buildingReport(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId), START, "2026-10-13"),
    );
    expect(actual.period.dayTypes).toEqual(expected.period.dayTypes);
    expect(actual.totals.kwh).toBeCloseTo(expected.totals.kwh, 0);
    expect(actual.totals.afterHoursKwh).toBeCloseTo(expected.totals.afterHoursKwh, 0);
    expect(actual.totals.avoidableKwh).toBeCloseTo(expected.totals.avoidableKwh, 0);
    expect(actual.totals.measuredShare).toBeCloseTo(expected.totals.measuredShare, 4);
    expect(seeded.findings).toBe(findings.length);
    expect(actual.byRule.reduce((s, r) => s + r.count, 0)).toBe(findings.length);
    // the shared library resolves the East China grid factor for this building
    expect(actual.scope2.locationFactor.region).toBe("CN-East");
    expect(actual.scope2.locationFactor.year).toBe(2023);
    // market-based: certificates prorated to the period (60 MWh over 184 days), the rest at the residual factor
    const green = (60_000 * 28) / 184;
    expect(actual.scope2.greenShare).toBeCloseTo(green / actual.scope2.kwh, 4);
    expect(actual.scope2.residualFactor?.kgPerKwh).toBe(0.6096);
    expect(actual.scope2.marketBasedKg).toBeCloseTo((actual.scope2.kwh - green) * 0.6096, 0);
  });

  it("is idempotent when days are processed again", async () => {
    const before = await ctxA(async (tx) => ({
      findings: (await tx.select({ n: sql<number>`count(*)::int` }).from(schema.findings))[0]!.n,
      kwh: (await tx.select({ s: sql<number>`sum(kwh_total)::float8` }).from(schema.floorDaily))[0]!.s,
    }));
    await ctxA(async (tx) =>
      processDays(
        tx,
        await loadBuildingContext(tx, seeded.orgId, seeded.buildingId),
        "2026-09-20",
        "2026-09-27",
      ),
    );
    const after = await ctxA(async (tx) => ({
      findings: (await tx.select({ n: sql<number>`count(*)::int` }).from(schema.findings))[0]!.n,
      kwh: (await tx.select({ s: sql<number>`sum(kwh_total)::float8` }).from(schema.floorDaily))[0]!.s,
    }));
    expect(after.findings).toBe(before.findings);
    expect(after.kwh).toBeCloseTo(before.kwh, 6);
  });

  it("builds nothing where the floors stopped reporting", async () => {
    // the seed ends on 2026-10-12; the days after it have no telemetry at all
    const result = await ctxA(async (tx) =>
      processDays(
        tx,
        await loadBuildingContext(tx, seeded.orgId, seeded.buildingId),
        "2026-10-14",
        "2026-10-16",
        Date.parse("2026-10-20T00:00:00Z"),
      ),
    );
    expect(result.intervals).toBe(0);
    const after = await ctxA(async (tx) => ({
      days: await tx
        .select({ day: schema.floorDaily.day })
        .from(schema.floorDaily)
        .where(sql`${schema.floorDaily.day} >= '2026-10-14'`),
      intervals: (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.floorIntervals)
          .where(sql`${schema.floorIntervals.startAt} >= '2026-10-14T00:00:00+08:00'`)
      )[0]!.n,
    }));
    expect(after.days).toEqual([]);
    expect(after.intervals).toBe(0);
  });

  it("never puts more avoidable energy on a day than the floor used that day", async () => {
    const over = await ctxA((tx) =>
      tx
        .select({ day: schema.floorDaily.day })
        .from(schema.floorDaily)
        .where(sql`${schema.floorDaily.avoidableKwh} > ${schema.floorDaily.kwhTotal} + 0.05`),
    );
    expect(over).toEqual([]);
  });

  it("keeps reviewed findings when late data removes them", async () => {
    await ctxA(async (tx) => {
      const [f] = await tx.select().from(schema.findings).limit(1);
      await tx.update(schema.findings).set({ status: "acknowledged" }).where(eq(schema.findings.id, f!.id));
    });
    const reviewed = await ctxA((tx) =>
      tx.select().from(schema.findings).where(eq(schema.findings.status, "acknowledged")),
    );
    expect(reviewed).toHaveLength(1);
  });

  it("deduplicates ingestion by idempotency key and validates devices", async () => {
    const floor = "F12";
    const batch = {
      readings: [],
      doorCounts: [{ device: deviceIds(floor).door, start: "2026-10-13T02:00:00Z", entries: 4, exits: 1 }],
      hvacEvents: [],
      lightingEvents: [],
    };
    const first = await ctxA(async (tx) =>
      ingestTelemetry(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId), {
        batch,
        idempotencyKey: "it-1",
      }),
    );
    const again = await ctxA(async (tx) =>
      ingestTelemetry(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId), {
        batch,
        idempotencyKey: "it-1",
      }),
    );
    expect(first.duplicate).toBe(false);
    expect(first.affected).toEqual({ fromDate: "2026-10-13", toDateExclusive: "2026-10-14" });
    expect(again).toMatchObject({ duplicate: true, batchId: first.batchId });

    const wrong = (b: object, key: string) =>
      ctxA(async (tx) =>
        ingestTelemetry(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId), {
          batch: { ...batch, ...b },
          idempotencyKey: key,
        }),
      );
    // a device of another organisation is invisible, hence unknown
    await expect(
      wrong({ doorCounts: [{ ...batch.doorCounts[0]!, device: "OTHER-DOOR" }] }, "it-2"),
    ).rejects.toThrow(IngestValidationError);
    // a door counter cannot report HVAC state
    await expect(
      wrong(
        { hvacEvents: [{ device: deviceIds(floor).door, at: "2026-10-13T02:00:00Z", mode: "full" }] },
        "it-3",
      ),
    ).rejects.toThrow(/bms_zone/);
    // timestamps in the future are rejected
    await expect(
      wrong({ doorCounts: [{ ...batch.doorCounts[0]!, start: "2099-01-01T00:00:00Z" }] }, "it-4"),
    ).rejects.toThrow(/future/);
  });

  describe("row-level security for the application role", () => {
    it("shows nothing without an organisation in context", async () => {
      expect(await app.db.select().from(schema.buildings)).toEqual([]);
      expect(await app.db.select().from(schema.floorIntervals).limit(1)).toEqual([]);
    });

    it("shows only the organisation in context", async () => {
      const seenByOther = await withOrg(app.db, otherOrg.orgId, async (tx) => ({
        buildings: await tx.select().from(schema.buildings),
        findings: await tx.select().from(schema.findings).limit(1),
        intervals: await tx.select().from(schema.floorIntervals).limit(1),
        daily: await tx.select().from(schema.floorDaily).limit(1),
      }));
      expect(seenByOther.buildings.map((b) => b.id)).toEqual([otherOrg.buildingId]);
      expect(seenByOther.findings).toEqual([]);
      expect(seenByOther.intervals).toEqual([]);
      expect(seenByOther.daily).toEqual([]);
      // even naming the other organisation's building explicitly does not load it
      await expect(
        withOrg(app.db, otherOrg.orgId, (tx) => loadBuildingContext(tx, seeded.orgId, seeded.buildingId)),
      ).rejects.toThrow(/not found/);
    });

    it("rejects writes into another organisation", async () => {
      await expect(
        withOrg(app.db, otherOrg.orgId, (tx) =>
          tx.insert(schema.floors).values({
            orgId: seeded.orgId,
            buildingId: seeded.buildingId,
            label: "X",
            level: 99,
            areaM2: 1,
            ratedHvacKw: 1,
            ratedLightingKw: 1,
          }),
        ),
      ).rejects.toThrow();
      const updated = await withOrg(app.db, otherOrg.orgId, (tx) =>
        tx
          .update(schema.buildings)
          .set({ name: "hijacked" })
          .where(eq(schema.buildings.id, seeded.buildingId))
          .returning(),
      );
      expect(updated).toEqual([]);
    });

    it("shares the factor library read-only", async () => {
      const visible = await withOrg(app.db, otherOrg.orgId, (tx) => tx.select().from(schema.emissionFactors));
      expect(visible.length).toBeGreaterThan(5);
      const changed = await withOrg(app.db, otherOrg.orgId, (tx) =>
        tx.update(schema.emissionFactors).set({ kgPerKwh: 0 }).where(sql`org_id is null`).returning(),
      );
      expect(changed).toEqual([]);
    });

    it("keeps the audit log append-only", async () => {
      await expect(ctxA((tx) => tx.update(schema.auditLog).set({ action: "x" }))).rejects.toThrow();
      await expect(ctxA((tx) => tx.delete(schema.auditLog))).rejects.toThrow();
    });
  });

  it("serves the overview and strategy figures", async () => {
    const { floors, strategies } = await ctxA(async (tx) => {
      const ctx = await loadBuildingContext(tx, seeded.orgId, seeded.buildingId);
      return {
        floors: await floorsNow(tx, ctx, "2026-10-12"),
        strategies: await strategySummary(tx, ctx, START, "2026-10-13"),
      };
    });
    expect(floors).toHaveLength(12);
    expect(floors[0]!.label).toBe("F16");
    expect(floors.reduce((s, f) => s + f.avoidableKwh28d, 0)).toBeGreaterThan(10_000);
    const full = strategies.strategies.find((s) => s.id === "full_package")!;
    expect(full.annualKwh).toBeGreaterThan(150_000);
    expect(full.capex).toBe(280_000);
  });

  it("deletes an organisation with all of its telemetry", async () => {
    const devices = await ctxA((tx) => tx.select({ id: schema.devices.id }).from(schema.devices));
    await deleteOrganization(app.db, seeded.orgId);
    const left = await owner.db.execute<{ n: number }>(
      sql`select (select count(*) from energy_readings where org_id = ${seeded.orgId})::int + (select count(*) from door_counts where org_id = ${seeded.orgId})::int as n`,
    );
    expect(left[0]!.n).toBe(0);
    expect(devices.length).toBeGreaterThan(0);
    expect(await ctxA((tx) => tx.select().from(schema.buildings))).toEqual([]);
  });
});
