/** Seeding the community from the public datasets. Requires TEST_DATABASE_URL (see database.integration.test.ts). */
import { createDb, type DbHandle, schema, withOrg } from "@flowcarbon/db";
import { deleteOrganization } from "@flowcarbon/pipeline";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeedResult, seedCommunity, seedDemo } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("seeding the community", () => {
  let tdb: TestDatabase;
  let owner: DbHandle;
  let app: DbHandle;
  let seeded: SeedResult;

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    owner = createDb(tdb.ownerUrl, { max: 2 });
    app = createDb(tdb.appUrl, { max: 2 });
    seeded = await seedDemo(app.db, { startDate: "2026-09-15", days: 28, password: "community-password" });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.drop();
  });

  const seededRows = () =>
    owner.db.select().from(schema.communityStrategies).where(isNull(schema.communityStrategies.orgId));

  it("lists one row per option of each dataset it finds, skipping the ones it does not", async () => {
    const lines: string[] = [];
    const { rows } = await seedCommunity(owner.db, undefined, (l) => lines.push(l));
    expect(rows).toBe(3);
    expect(lines).toContain("no organisation lbnl-b59-case; skipped");
    const stored = await seededRows();
    expect(stored.map((r) => r.optionKind).sort()).toEqual(["balanced", "weekdays", "weekends"]);
    for (const r of stored) {
      expect(r).toMatchObject({
        orgId: null,
        alias: "Simulated demo tower",
        floorsCount: 12,
        locale: "en",
        uses: 0,
        result: { basis: "expected", days: 28, simulated: true },
      });
      expect(r.result.avoidableShareAfter).toBeLessThan(r.result.avoidableShareBefore);
      expect(r.summary).toMatch(/^Expected: /);
      expect(JSON.stringify(r.strategyMix)).not.toContain("floorId");
    }
  });

  it("refreshes the same rows when run again, leaving their uses alone", async () => {
    const before = await seededRows();
    const row = before[0]!;
    await app.db.execute(sql`select community_strategy_used(${row.id}::uuid)`);
    await owner.db
      .update(schema.communityStrategies)
      .set({ summary: "Out of date" })
      .where(eq(schema.communityStrategies.id, row.id));

    await seedCommunity(owner.db);
    const after = await seededRows();
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    const same = after.find((r) => r.id === row.id)!;
    expect(same.uses).toBe(1);
    expect(same.summary).toBe(row.summary);
  });

  it("is readable by every organisation and writable by none", async () => {
    const seen = await withOrg(app.db, seeded.orgId, (tx) => tx.select().from(schema.communityStrategies));
    expect(seen).toHaveLength(3);
    await expect(seedCommunity(app.db)).rejects.toThrow();
  });

  it("goes with its building, so a dataset can be replaced", async () => {
    await deleteOrganization(app.db, seeded.orgId);
    expect(await seededRows()).toEqual([]);
  });
});
