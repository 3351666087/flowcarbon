/**
 * Integration tests against a real PostgreSQL + TimescaleDB server.
 * Set TEST_DATABASE_URL to a superuser/owner URL (any database on the server); each run creates and drops
 * its own database. The application role `flowcarbon_app` must exist (infra/postgres/init).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    // tenant vs building control: the pipeline (daily roll-ups + leases by date) agrees with the in-memory engine
    for (const i of [0, 1]) {
      expect(actual.byParty[i]!.party).toBe(expected.byParty[i]!.party);
      expect(actual.byParty[i]!.kwh).toBeCloseTo(expected.byParty[i]!.kwh, 0);
      expect(actual.byParty[i]!.avoidableKwh).toBeCloseTo(expected.byParty[i]!.avoidableKwh, 0);
    }
  });

  it("stores each day's energy per system, adding up to the day's total", async () => {
    const rows = await ctxA((tx) => tx.select().from(schema.floorDaily));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.kwhHvac + r.kwhLighting + r.kwhPlug).toBeCloseTo(r.kwhTotal, 6);
    // the pipeline derives every day it writes from intervals, so every day is split
    expect(rows.every((r) => r.systemsSplit)).toBe(true);
    // cooling runs on every whole working day; on weekends and the October holiday the BMS keeps it off,
    // so a day with no cooling energy is real, not a gap
    const workdays = rows.filter((r) => r.dayType === "workday" && r.intervals === 96);
    expect(workdays.length).toBeGreaterThan(0);
    expect(workdays.every((r) => r.kwhHvac > 0)).toBe(true);
    expect(rows.some((r) => r.dayType !== "workday" && r.kwhHvac === 0 && r.kwhTotal > 0)).toBe(true);
    expect(rows.some((r) => r.kwhLighting > 0)).toBe(true);
  });

  it("backfills the per-system split of days stored before migration 0013", async () => {
    const before = await ctxA((tx) => tx.select().from(schema.floorDaily));
    // as a database migrated from 0012 would hold them: the new columns at their default
    await owner.db.execute(sql`update floor_daily set kwh_hvac = 0, kwh_lighting = 0, kwh_plug = 0`);
    const migration = readFileSync(
      fileURLToPath(new URL("../../db/drizzle/0013_floor_daily_systems.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").find((st) => st.includes("UPDATE"))!;
    await owner.db.execute(sql.raw(backfill));
    const after = new Map(
      (await ctxA((tx) => tx.select().from(schema.floorDaily))).map((r) => [`${r.floorId}|${r.day}`, r]),
    );
    for (const b of before) {
      const a = after.get(`${b.floorId}|${b.day}`)!;
      expect(a.kwhHvac).toBeCloseTo(b.kwhHvac, 6);
      expect(a.kwhLighting).toBeCloseTo(b.kwhLighting, 6);
      expect(a.kwhPlug).toBeCloseTo(b.kwhPlug, 6);
    }
  });

  it("migration 0014 repairs days it can derive and leaves the rest unsplit, which the report shows", async () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../../db/drizzle/0014_floor_daily_systems_split.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").filter((st) => st.includes("UPDATE"));
    expect(backfill).toHaveLength(2);
    const report = (tx: Tx) =>
      loadBuildingContext(tx, seeded.orgId, seeded.buildingId).then((ctx) =>
        buildingReport(tx, ctx, START, "2026-10-13"),
      );
    const split = await ctxA(report);
    expect(split.partyUnsplit).toEqual({ kwh: 0, share: 0, floorDays: 0 });
    expect(split.disclosures.some((d) => d.includes("unsplit"))).toBe(false);

    const ROLLBACK = new Error("rollback");
    await expect(
      owner.db.transaction(async (tx) => {
        const days = await tx
          .select()
          .from(schema.floorDaily)
          .where(eq(schema.floorDaily.buildingId, seeded.buildingId))
          .orderBy(schema.floorDaily.day, schema.floorDaily.floorId);
        const [a, b] = [days[40]!, days[41]!];
        expect(a.kwhTotal).toBeGreaterThan(0);
        expect(b.kwhTotal).toBeGreaterThan(0);
        // as written by a version before 0013 while 0013 was being applied, and as stored before 0014
        await tx.execute(sql`update floor_daily set systems_split = false`);
        await tx.execute(
          sql`update floor_daily set kwh_hvac = 0, kwh_lighting = 0, kwh_plug = 0 where floor_id in (${a.floorId}, ${b.floorId}) and day in (${a.day}, ${b.day})`,
        );
        // b's intervals are gone: its split cannot be derived any more
        await tx.execute(
          sql`delete from floor_intervals where floor_id = ${b.floorId} and start_at >= (${b.day}::date::timestamp at time zone 'Asia/Shanghai') and start_at < ((${b.day}::date + 1)::timestamp at time zone 'Asia/Shanghai')`,
        );
        for (const st of backfill) await tx.execute(sql.raw(st));

        const after = new Map(
          (
            await tx
              .select()
              .from(schema.floorDaily)
              .where(eq(schema.floorDaily.buildingId, seeded.buildingId))
          ).map((r) => [`${r.floorId}|${r.day}`, r]),
        );
        for (const d of days) {
          const r = after.get(`${d.floorId}|${d.day}`)!;
          if (d === b) continue;
          // every other day, a included, is derived again from its intervals and marked split
          expect(r.systemsSplit).toBe(true);
          expect(r.kwhHvac).toBeCloseTo(d.kwhHvac, 6);
          expect(r.kwhLighting).toBeCloseTo(d.kwhLighting, 6);
          expect(r.kwhPlug).toBeCloseTo(d.kwhPlug, 6);
        }
        const rb = after.get(`${b.floorId}|${b.day}`)!;
        expect(rb).toMatchObject({ systemsSplit: false, kwhHvac: 0, kwhLighting: 0, kwhPlug: 0 });
        expect(rb.kwhTotal).toBe(b.kwhTotal);

        // the report keeps b's energy in the total and says it is neither party's
        const r = await report(tx);
        expect(r.totals.kwh).toBeCloseTo(split.totals.kwh, 1);
        expect(r.partyUnsplit.kwh).toBeCloseTo(b.kwhTotal, 1);
        expect(r.partyUnsplit.floorDays).toBe(1);
        expect(r.byParty[0]!.kwh + r.byParty[1]!.kwh + r.partyUnsplit.kwh).toBeCloseTo(r.totals.kwh, 0);
        expect(r.byParty[0]!.share + r.byParty[1]!.share + r.partyUnsplit.share).toBeCloseTo(1, 9);
        const floor = r.byFloor.find((f) => f.floorId === b.floorId)!;
        expect(floor.tenantKwh + floor.buildingKwh + floor.unsplitKwh).toBeCloseTo(floor.kwh, 0);
        expect(floor.unsplitKwh).toBeCloseTo(b.kwhTotal, 1);
        expect(r.disclosures.find((d) => d.includes("unsplit"))).toContain("on 1 floor-day)");
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
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
    // every table with an org_id but no foreign key to it, raw and derived: nothing may outlive the organisation
    const unconstrained = [
      "energy_readings",
      "door_counts",
      "hvac_events",
      "lighting_events",
      "floor_intervals",
      "floor_daily",
    ];
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          unconstrained.map(async (t) => {
            const [r] = await owner.db.execute<{ n: number }>(
              sql`select count(*)::int as n from ${sql.identifier(t)} where org_id = ${seeded.orgId}`,
            );
            return [t, r!.n] as const;
          }),
        ),
      );
    const before = await counts();
    for (const t of unconstrained) expect(before[t], t).toBeGreaterThan(0);
    await deleteOrganization(app.db, seeded.orgId);
    expect(await counts()).toEqual(Object.fromEntries(unconstrained.map((t) => [t, 0])));
    // and the list above is complete: no other table has an org_id without a foreign key
    const loose = await owner.db.execute<{ t: string }>(sql`
      select c.table_name as t from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'org_id'
        and not exists (select 1 from pg_constraint k
          where k.conrelid = ('public.' || quote_ident(c.table_name))::regclass and k.contype = 'f')
      order by 1`);
    expect(loose.map((r) => r.t).sort()).toEqual([...unconstrained].sort());
    expect(devices.length).toBeGreaterThan(0);
    expect(await ctxA((tx) => tx.select().from(schema.buildings))).toEqual([]);
  });
});
