/**
 * The demo pump against a real database (TEST_DATABASE_URL, see database.integration.test.ts).
 */
import { zonedTime } from "@flowcarbon/core";
import { createDb, type DbHandle, schema, withOrg } from "@flowcarbon/db";
import { and, count, eq, gte, inArray, lt, max } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pumpDemo, seedDemo } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const adminUrl = process.env.TEST_DATABASE_URL;
const TZ = "Asia/Shanghai";
const SLUG = "pump-test";
const at = (day: string, hh: number, mm = 0) => zonedTime(day, hh * 60 + mm, TZ);

describe.skipIf(!adminUrl)("demo pump", () => {
  let tdb: TestDatabase;
  let app: DbHandle;
  let orgId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    app = createDb(tdb.appUrl, { max: 4 });
    // seeded window: 14 and 15 September (complete days)
    const seeded = await seedDemo(app.db, {
      slug: SLUG,
      startDate: "2026-09-14",
      days: 2,
      password: "pump-test-password",
    });
    orgId = seeded.orgId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.drop();
  });

  const state = () =>
    withOrg(app.db, orgId, async (tx) => {
      const [iv] = await tx
        .select({ n: count(), last: max(schema.floorIntervals.startAt) })
        .from(schema.floorIntervals);
      const [dc] = await tx
        .select({ n: count(), last: max(schema.doorCounts.startAt) })
        .from(schema.doorCounts)
        .where(eq(schema.doorCounts.orgId, orgId));
      const [seededHvac] = await tx
        .select({ n: count() })
        .from(schema.hvacEvents)
        .where(
          and(eq(schema.hvacEvents.orgId, orgId), lt(schema.hvacEvents.at, new Date(at("2026-09-16", 0)))),
        );
      const [ot] = await tx.select({ n: count() }).from(schema.overtimeRequests);
      const [fd] = await tx.select({ n: count() }).from(schema.floorDaily);
      return {
        intervals: iv!.n,
        lastInterval: iv!.last!.getTime(),
        doorCounts: dc!.n,
        lastDoorCount: dc!.last!.getTime(),
        seededHvacEvents: seededHvac!.n,
        overtime: ot!.n,
        floorDays: fd!.n,
      };
    });

  it("continues after the seeded window up to now and writes nothing in the future", async () => {
    const before = await state();
    const now = at("2026-09-16", 10, 7);
    const r = await pumpDemo(app.db, { slug: SLUG, now });
    expect(r.days).toEqual(["2026-09-16"]);
    const after = await state();
    expect(after.lastDoorCount + 15 * 60_000).toBeLessThanOrEqual(now);
    expect(after.lastDoorCount).toBeGreaterThanOrEqual(now - 30 * 60_000);
    expect(after.lastInterval).toBeLessThan(now);
    expect(after.intervals).toBeGreaterThan(before.intervals);
    expect(after.floorDays).toBe(before.floorDays + 12);
    // the complete seeded days are left as they were
    expect(after.seededHvacEvents).toBe(before.seededHvacEvents);
  });

  it("is idempotent for the same moment", async () => {
    const now = at("2026-09-16", 10, 7);
    const before = await state();
    await pumpDemo(app.db, { slug: SLUG, now });
    expect(await state()).toEqual(before);
  });

  it("catches up across days, continuing the day it left unfinished", async () => {
    const before = await state();
    const now = at("2026-09-18", 8, 0);
    const r = await pumpDemo(app.db, { slug: SLUG, now });
    expect(r.days).toEqual(["2026-09-16", "2026-09-17", "2026-09-18"]);
    const after = await state();
    expect(after.lastDoorCount + 15 * 60_000).toBeLessThanOrEqual(now);
    expect(after.floorDays).toBe(before.floorDays + 24);
    expect(after.seededHvacEvents).toBe(before.seededHvacEvents);
    expect(after.overtime).toBeGreaterThanOrEqual(before.overtime);
  });

  it("runs a floor by the measure put into effect on it, so its waste stops", async () => {
    const from = at("2026-09-18", 8, 0);
    const covered = ["hvac_empty_floor", "full_floor_few_people"];
    const [floor] = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(schema.floors).where(eq(schema.floors.label, "F10")),
    );
    await withOrg(app.db, orgId, async (tx) => {
      const [b] = await tx.select().from(schema.buildings);
      await tx.insert(schema.measures).values({
        orgId,
        buildingId: b!.id,
        floorId: floor!.id,
        strategyId: "occupancy_gated_workday",
        source: "manual",
        originRuleId: "full_floor_few_people",
        status: "in_effect",
        implementedAt: new Date(from),
      });
    });
    await pumpDemo(app.db, { slug: SLUG, now: at("2026-09-23", 8, 0) });
    const since = (onFloor: boolean) =>
      withOrg(app.db, orgId, (tx) =>
        tx
          .select({ floorId: schema.findings.floorId, dayType: schema.findings.dayType })
          .from(schema.findings)
          .where(
            and(
              gte(schema.findings.startAt, new Date(from)),
              inArray(schema.findings.ruleId, covered),
              eq(schema.findings.dayType, "workday"),
            ),
          )
          .then((rows) => rows.filter((r) => (r.floorId === floor!.id) === onFloor)),
      );
    // the other floors still waste the way they did, F10 no longer does
    expect((await since(false)).length).toBeGreaterThan(0);
    expect(await since(true)).toEqual([]);
  });
});
