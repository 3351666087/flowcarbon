/**
 * The planner over a real database, as the runtime role, and the tables behind the assistant and the community.
 * Requires TEST_DATABASE_URL (see database.integration.test.ts).
 */
import { REALISATION, type RuleId, STRATEGIES, type StrategyId } from "@flowcarbon/core";
import { createDb, type DbHandle, schema, type Tx, withOrg } from "@flowcarbon/db";
import {
  type BuildingContext,
  buildingReport,
  latestDataDay,
  loadBuildingContext,
  planData,
  strategyBoard,
} from "@flowcarbon/pipeline";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeedResult, seedDemo } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const adminUrl = process.env.TEST_DATABASE_URL;
const START = "2026-09-15";
const DAYS = 28;
const END = "2026-10-13"; // the seeded data stops the day before
/** long after the seeded data stopped, so this building stands in for one whose data ended */
const NOW = Date.parse("2026-12-01T04:00:00Z");

class Rollback extends Error {}

describe.skipIf(!adminUrl)("plans over a database", () => {
  let tdb: TestDatabase;
  let owner: DbHandle;
  let app: DbHandle;
  let seeded: SeedResult;
  let other: { orgId: string; buildingId: string };

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    owner = createDb(tdb.ownerUrl, { max: 2 });
    app = createDb(tdb.appUrl, { max: 4 });
    seeded = await seedDemo(app.db, { startDate: START, days: DAYS, password: "plans-test-password" });
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
      await tx.insert(schema.floors).values({
        orgId: org!.id,
        buildingId: b!.id,
        label: "F1",
        level: 1,
        areaM2: 1000,
        ratedHvacKw: 40,
        ratedLightingKw: 8,
      });
      return b!.id;
    });
    other = { orgId: org!.id, buildingId };
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.drop();
  });

  const inOrg = <T>(fn: (tx: Tx, ctx: BuildingContext) => Promise<T>) =>
    withOrg(app.db, seeded.orgId, async (tx) =>
      fn(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId)),
    );
  const inOther = <T>(fn: (tx: Tx, ctx: BuildingContext) => Promise<T>) =>
    withOrg(app.db, other.orgId, async (tx) =>
      fn(tx, await loadBuildingContext(tx, other.orgId, other.buildingId)),
    );
  /** Runs a scenario that changes the seeded data, and leaves no trace of it for the next test. */
  const rolledBack = (fn: (tx: Tx, ctx: BuildingContext) => Promise<void>) =>
    inOrg(async (tx, ctx) => {
      await fn(tx, ctx);
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });

  /** Agrees a measure on a floor, as adopting one does, with the floor's open findings it covers linked to it. */
  async function adopt(
    tx: Tx,
    ctx: BuildingContext,
    floorId: string,
    strategyId: Exclude<StrategyId, "full_package">,
    status: "planned" | "in_effect" = "planned",
  ) {
    const rules = STRATEGIES[strategyId].covers;
    const covered = await tx
      .select({ id: schema.findings.id, ruleId: schema.findings.ruleId, dayType: schema.findings.dayType })
      .from(schema.findings)
      .where(and(eq(schema.findings.floorId, floorId), eq(schema.findings.status, "open")));
    const ids = covered
      .filter((f) => rules.some((c) => c.rule === f.ruleId && c.dayTypes.includes(f.dayType)))
      .map((f) => f.id);
    const [m] = await tx
      .insert(schema.measures)
      .values({
        orgId: seeded.orgId,
        buildingId: ctx.building.id,
        floorId,
        strategyId,
        source: "ai",
        originRuleId: rules[0]!.rule as RuleId,
        status,
      })
      .returning();
    await tx
      .update(schema.findings)
      .set({ status: status === "in_effect" ? "fixed" : "acknowledged", measureId: m!.id })
      .where(inArray(schema.findings.id, ids));
    return { measure: m!, findings: ids.length };
  }

  describe("planData", () => {
    it("plans on the last 28 days of data, even long after they ended", async () => {
      await inOrg(async (tx, ctx) => {
        const plan = await planData(tx, ctx, {}, NOW);
        expect(await latestDataDay(tx, ctx)).toBe("2026-10-12");
        expect(plan.window).toMatchObject({ from: START, to: END, days: DAYS });
        const { workday, weekend, holiday } = plan.window.observed;
        expect(workday + weekend + holiday).toBe(DAYS);
      });
    });

    it("starts from the same figures the building already shows", async () => {
      await inOrg(async (tx, ctx) => {
        const { before } = await planData(tx, ctx, {}, NOW);
        const report = await buildingReport(tx, ctx, START, END);
        expect(before.kwh).toBe(report.totals.kwh);
        expect(before.cost).toBe(report.totals.cost);
        expect(before.avoidableKwh).toBe(report.totals.avoidableKwh);
        expect(before.avoidableShare).toBeCloseTo(report.totals.avoidableShare, 6);
        expect(before.co2eKg).toBeCloseTo(report.scope2.locationBasedKg, 0);
        expect(before.greenShare).toBeCloseTo(report.scope2.greenShare, 6);
      });
    });

    it("offers all three options on the demo tower, with real savings and a green share that rises", async () => {
      await inOrg(async (tx, ctx) => {
        const plan = await planData(tx, ctx, {}, NOW);
        expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
        const floors = new Set(ctx.floors.map((f) => f.id));
        for (const o of plan.options) {
          expect(o.actions.length).toBeGreaterThan(0);
          expect(o.actions.length).toBeLessThanOrEqual(8);
          expect(o.actions.every((a) => floors.has(a.floorId))).toBe(true);
          expect(o.after.kwh).toBeLessThan(plan.before.kwh);
          expect(o.after.avoidableShare).toBeLessThan(plan.before.avoidableShare);
          expect(o.after.greenShare).toBeGreaterThan(plan.before.greenShare);
          expect(o.after.cost / o.after.kwh).toBeCloseTo(plan.before.cost / plan.before.kwh, 3);
          expect(o.high.kwh).toBeLessThan(o.after.kwh);
          expect(o.after.kwh).toBeLessThan(o.low.kwh);
          expect(o.annualSavingKwh).toBeGreaterThan(0);
          expect(o.capex).toBeGreaterThan(0);
        }
        const balanced = plan.options.find((o) => o.id === "balanced")!;
        const weekendSide = balanced.actions.filter((a) => a.strategyId === "zone_only_non_working");
        expect(weekendSide).toHaveLength(balanced.actions.length / 2);
      });
    });

    it("gives no investment figure for a building in a currency the estimate is not in", async () => {
      await inOrg(async (tx, ctx) => {
        const elsewhere = { ...ctx, building: { ...ctx.building, currency: "USD" } };
        const plan = await planData(tx, elsewhere);
        expect(plan.options.length).toBeGreaterThan(0);
        for (const o of plan.options) expect(o.capex).toBeNull();
      });
    });

    it("covers no more than the findings in the window hold, each counted once", async () => {
      await inOrg(async (tx, ctx) => {
        const plan = await planData(
          tx,
          ctx,
          { target: { kind: "avoidable_cut", value: 1 }, focus: "all" },
          NOW,
        );
        const [row] = await tx
          .select({ kwh: sql<number>`sum(${schema.findings.avoidableKwh})::float8` })
          .from(schema.findings)
          .where(and(eq(schema.findings.buildingId, ctx.building.id), eq(schema.findings.status, "open")));
        const balanced = plan.options.find((o) => o.id === "balanced")!;
        const covered = balanced.actions.reduce((s, a) => s + a.coveredKwh, 0);
        expect(covered).toBeCloseTo(row!.kwh, 0);
        const keys = balanced.actions.map((a) => `${a.floorId}|${a.strategyId}`);
        expect(new Set(keys).size).toBe(keys.length);
      });
    });

    it("stops at a target and honours focus and floors", async () => {
      await inOrg(async (tx, ctx) => {
        const free = await planData(tx, ctx, {}, NOW);
        const value = free.before.avoidableShare * 0.8;
        const plan = await planData(
          tx,
          ctx,
          { target: { kind: "avoidable_share", value }, focus: "hvac" },
          NOW,
        );
        expect(plan.alreadyMet).toBe(false);
        const reached = plan.options.filter((o) => o.reachesTarget);
        expect(reached.length).toBeGreaterThan(0);
        for (const o of reached) expect(o.after.avoidableShare).toBeLessThanOrEqual(value);
        expect(plan.options.flatMap((o) => o.actions.map((a) => a.strategyId))).not.toContain(
          "auto_lights_off",
        );

        const floorId = free.options[0]!.actions[0]!.floorId;
        const one = await planData(tx, ctx, { floorIds: [floorId] }, NOW);
        expect(new Set(one.options.flatMap((o) => o.actions.map((a) => a.floorId)))).toEqual(
          new Set([floorId]),
        );

        const met = await planData(tx, ctx, { target: { kind: "avoidable_share", value: 0.99 } }, NOW);
        expect(met.alreadyMet).toBe(true);
        expect(met.options.length).toBe(free.options.length);
      });
    });

    it("leaves out what an active measure already answers, linked or not", async () => {
      await rolledBack(async (tx, ctx) => {
        const free = await planData(tx, ctx, {}, NOW);
        const first = free.options[0]!.actions[0]!;
        const { measure } = await adopt(tx, ctx, first.floorId, first.strategyId);
        const key = `${first.floorId}|${first.strategyId}`;
        const pairs = (p: typeof free) =>
          p.options.flatMap((o) => o.actions.map((a) => `${a.floorId}|${a.strategyId}`));
        expect(pairs(await planData(tx, ctx, {}, NOW))).not.toContain(key);

        // the same findings put back to open, unlinked: they came back under the measure, which still answers them
        await tx
          .update(schema.findings)
          .set({ status: "open", measureId: null })
          .where(eq(schema.findings.measureId, measure.id));
        expect(pairs(await planData(tx, ctx, {}, NOW))).not.toContain(key);

        // cancelled, they are open again
        await tx
          .update(schema.measures)
          .set({ status: "cancelled" })
          .where(eq(schema.measures.id, measure.id));
        expect(pairs(await planData(tx, ctx, {}, NOW))).toContain(key);
      });
    });

    it("leaves out today while it is still coming in, so a part of a day is not an average day", async () => {
      await inOrg(async (tx, ctx) => {
        const live = await planData(tx, ctx, {}, Date.parse("2026-10-12T04:00:00Z"));
        expect(live.window).toMatchObject({ to: "2026-10-12", days: DAYS - 1 });
        const ended = await planData(tx, ctx, {}, NOW);
        expect(ended.window).toMatchObject({ to: "2026-10-13", days: DAYS });
      });
    });

    it("counts only days that have data, and never invents the rest", async () => {
      await rolledBack(async (tx, ctx) => {
        await tx
          .delete(schema.floorDaily)
          .where(
            and(eq(schema.floorDaily.buildingId, ctx.building.id), gte(schema.floorDaily.day, "2026-09-25")),
          );
        const plan = await planData(tx, ctx, {}, NOW);
        // the data now stops on 24 September: the window ends there, and only the ten days that exist count
        expect(plan.window).toMatchObject({ from: "2026-08-28", to: "2026-09-25", days: 10 });
        const { workday, weekend, holiday } = plan.window.observed;
        expect(workday + weekend + holiday).toBe(10);
      });
    });

    it("gives a building with no data an empty plan rather than an error", async () => {
      await inOther(async (tx, ctx) => {
        const plan = await planData(
          tx,
          ctx,
          { target: { kind: "avoidable_share", value: 0.05 }, focus: "all" },
          NOW,
        );
        expect(plan).toMatchObject({
          before: { kwh: 0, avoidableShare: 0, greenShare: 0 },
          options: [],
          alreadyMet: false,
          window: { from: "2026-12-01", to: "2026-12-01", days: 0 },
        });
      });
    });
  });

  describe("strategyBoard", () => {
    it("shows the plan, nothing adopted, and a week ahead with both lines equal", async () => {
      await inOrg(async (tx, ctx) => {
        const board = await strategyBoard(tx, ctx, NOW);
        expect(board.plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
        expect(board.adopted.measures).toEqual([]);
        expect(board.adopted.after).toEqual(board.plan.before);
        // a building whose data ended looks ahead from where it stopped
        expect(board.week.days.map((d) => d.date)).toEqual([
          "2026-10-13",
          "2026-10-14",
          "2026-10-15",
          "2026-10-16",
          "2026-10-17",
          "2026-10-18",
          "2026-10-19",
        ]);
        expect(board.week.days.map((d) => d.dayType).slice(4, 6)).toEqual(["weekend", "weekend"]);
        for (const d of board.week.days) {
          expect(d.basis).toBeGreaterThan(0);
          expect(d.withoutKwh).toBeGreaterThan(0);
          expect(d.withKwh).toBe(d.withoutKwh);
        }
      });
    });

    it("looks ahead from today while the data is current", async () => {
      await inOrg(async (tx, ctx) => {
        const board = await strategyBoard(tx, ctx, Date.parse("2026-10-12T04:00:00Z"));
        expect(board.week.days[0]!.date).toBe("2026-10-12");
      });
    });

    it("averages the week per kind of day from the window", async () => {
      await inOrg(async (tx, ctx) => {
        const board = await strategyBoard(tx, ctx, NOW);
        const report = await buildingReport(tx, ctx, START, END);
        const workdays = report.byDayType.find((t) => t.dayType === "workday")!;
        const tuesday = board.week.days[0]!;
        expect(tuesday.dayType).toBe("workday");
        expect(tuesday.basis).toBe(workdays.days);
        expect(tuesday.withoutKwh).toBeCloseTo(workdays.kwh / workdays.days, 1);
      });
    });

    it("moves adopted measures into `adopted` and out of the options, with the week following", async () => {
      await rolledBack(async (tx, ctx) => {
        const free = await strategyBoard(tx, ctx, NOW);
        const first = free.plan.options[0]!.actions[0]!;
        const { measure, findings } = await adopt(tx, ctx, first.floorId, first.strategyId, "in_effect");
        expect(findings).toBe(first.findings);

        const board = await strategyBoard(tx, ctx, NOW);
        expect(board.adopted.measures).toMatchObject([
          {
            id: measure.id,
            floorId: first.floorId,
            strategyId: first.strategyId,
            status: "in_effect",
            coveredKwh: first.coveredKwh,
            findings: first.findings,
          },
        ]);
        const saved = first.coveredKwh * REALISATION.mid;
        expect(board.adopted.after.kwh).toBeCloseTo(free.plan.before.kwh - saved, 0);
        expect(board.adopted.after.avoidableKwh).toBeCloseTo(free.plan.before.avoidableKwh - saved, 0);
        expect(board.plan.recorded).toEqual(free.plan.recorded);
        expect(board.plan.before).toEqual(board.adopted.after);
        expect(board.plan.adoptedKwh).toBe(first.coveredKwh);

        const lower = board.week.days.filter((d) => d.withKwh < d.withoutKwh);
        expect(lower.length).toBeGreaterThan(0);
        for (const t of ["workday", "weekend", "holiday"] as const) {
          if (first.byDayType[t] === 0) continue;
          const day = board.week.days.find((d) => d.dayType === t);
          if (day) {
            const off = (first.byDayType[t] * REALISATION.mid) / day.basis;
            expect(day.withoutKwh - day.withKwh).toBeCloseTo(off, 0);
          }
        }
      });
    });

    it("counts no saving for an on-site check, which only opens a check", async () => {
      await rolledBack(async (tx, ctx) => {
        const free = await strategyBoard(tx, ctx, NOW);
        const first = free.plan.options[0]!.actions[0]!;
        const { measure } = await adopt(tx, ctx, first.floorId, first.strategyId);
        await tx
          .update(schema.measures)
          .set({ strategyId: "investigate_on_site" })
          .where(eq(schema.measures.id, measure.id));

        const board = await strategyBoard(tx, ctx, NOW);
        expect(board.adopted.measures[0]).toMatchObject({ id: measure.id, coveredKwh: first.coveredKwh });
        expect(board.plan.adoptedKwh).toBe(0);
        expect(board.adopted.after).toEqual(free.plan.before);
        for (const d of board.week.days) expect(d.withKwh).toBe(d.withoutKwh);
      });
    });

    it("gives the client per-strategy coverage for every option", async () => {
      await inOrg(async (tx, ctx) => {
        const { plan, week } = await strategyBoard(tx, ctx, NOW);
        for (const o of plan.options) {
          const strategies = new Set(o.actions.map((a) => a.strategyId));
          const rows = week.coverage.filter((c) => c.option === o.id);
          expect(new Set(rows.map((c) => c.strategyId))).toEqual(strategies);
          // over the window's own days it comes back to the option's saving
          const { observed } = plan.window;
          const saved = rows.reduce(
            (s, c) =>
              s +
              c.perDayKwh.workday * observed.workday +
              c.perDayKwh.weekend * observed.weekend +
              c.perDayKwh.holiday * observed.holiday,
            0,
          );
          expect(saved).toBeCloseTo(plan.before.kwh - o.after.kwh, -1);
        }
      });
    });

    it("works for a building with no data", async () => {
      await inOther(async (tx, ctx) => {
        const board = await strategyBoard(tx, ctx, NOW);
        expect(board.plan.options).toEqual([]);
        expect(board.week.coverage).toEqual([]);
        expect(board.week.days[0]).toMatchObject({ date: "2026-12-01", basis: 0, withoutKwh: 0, withKwh: 0 });
      });
    });
  });

  describe("tables behind the assistant and the community", () => {
    const entry = (over: Partial<typeof schema.communityStrategies.$inferInsert> = {}) => ({
      orgId: seeded.orgId,
      buildingId: seeded.buildingId,
      alias: "Tower A",
      title: "Weekends off",
      summary: "Zone-only cooling on weekends.",
      optionKind: "weekends" as const,
      strategyMix: [{ strategyId: "zone_only_non_working" as const, floorShare: 0.5 }],
      floorsCount: 12,
      areaBand: "10-20k",
      result: {
        avoidableShareBefore: 0.12,
        avoidableShareAfter: 0.06,
        energyCutPct: 5,
        basis: "expected" as const,
        days: 28,
      },
      ...over,
    });

    it("keeps assistant turns to their organisation", async () => {
      const [turn] = await inOrg((tx) =>
        tx
          .insert(schema.assistantTurns)
          .values({ orgId: seeded.orgId, buildingId: seeded.buildingId, prompt: "Lights off on F7" })
          .returning(),
      );
      expect(turn).toMatchObject({ status: "pending", locale: "en", model: null, appliedOption: null });
      expect(await inOther((tx) => tx.select().from(schema.assistantTurns))).toEqual([]);
      await expect(
        inOther((tx) =>
          tx
            .insert(schema.assistantTurns)
            .values({ orgId: seeded.orgId, buildingId: seeded.buildingId, prompt: "Not mine" }),
        ),
      ).rejects.toThrow();
      const { plan, reply } = (await inOrg((tx) => tx.select().from(schema.assistantTurns)))[0]!;
      expect([plan, reply]).toEqual([null, null]);
    });

    it("shows a published strategy to every organisation and lets only its own touch it", async () => {
      const [mine] = await inOrg((tx) => tx.insert(schema.communityStrategies).values(entry()).returning());
      expect(mine).toMatchObject({ uses: 0, withdrawnAt: null, locale: "en" });

      const seen = await inOther((tx) => tx.select().from(schema.communityStrategies));
      expect(seen.map((r) => r.id)).toContain(mine!.id);

      // updates and deletes from another organisation find nothing; a forged insert is refused
      const touched = await inOther((tx) =>
        tx
          .update(schema.communityStrategies)
          .set({ title: "Hijacked" })
          .where(eq(schema.communityStrategies.id, mine!.id))
          .returning(),
      );
      expect(touched).toEqual([]);
      const removed = await inOther((tx) =>
        tx.delete(schema.communityStrategies).where(eq(schema.communityStrategies.id, mine!.id)).returning(),
      );
      expect(removed).toEqual([]);
      await expect(inOther((tx) => tx.insert(schema.communityStrategies).values(entry()))).rejects.toThrow();
      await expect(
        inOther((tx) => tx.insert(schema.communityStrategies).values(entry({ orgId: null }))),
      ).rejects.toThrow();
    });

    it("counts a use from another organisation through the one narrow function", async () => {
      const [mine] = await inOrg((tx) =>
        tx
          .insert(schema.communityStrategies)
          .values(entry({ optionKind: "balanced" }))
          .returning(),
      );
      await inOther((tx) => tx.execute(sql`select community_strategy_used(${mine!.id}::uuid)`));
      const [row] = await inOrg((tx) =>
        tx
          .select({ uses: schema.communityStrategies.uses })
          .from(schema.communityStrategies)
          .where(eq(schema.communityStrategies.id, mine!.id)),
      );
      expect(row!.uses).toBe(1);
    });

    it("withdraws a strategy from everyone else while its owner keeps the record", async () => {
      const [mine] = await inOrg((tx) =>
        tx
          .insert(schema.communityStrategies)
          .values(entry({ optionKind: "weekdays" }))
          .returning(),
      );
      const [gone] = await inOrg((tx) =>
        tx
          .update(schema.communityStrategies)
          .set({ withdrawnAt: new Date() })
          .where(eq(schema.communityStrategies.id, mine!.id))
          .returning(),
      );
      expect(gone!.withdrawnAt).not.toBeNull();
      const seen = await inOther((tx) => tx.select().from(schema.communityStrategies));
      expect(seen.map((r) => r.id)).not.toContain(mine!.id);
      await inOther((tx) => tx.execute(sql`select community_strategy_used(${mine!.id}::uuid)`));
      const [row] = await inOrg((tx) =>
        tx
          .select({ uses: schema.communityStrategies.uses })
          .from(schema.communityStrategies)
          .where(eq(schema.communityStrategies.id, mine!.id)),
      );
      expect(row!.uses).toBe(0);
    });

    it("keeps one seeded row per building and option, readable by all and writable by none", async () => {
      const seededRow = entry({ orgId: null, alias: "Public dataset", optionKind: "custom" });
      const [row] = await owner.db.insert(schema.communityStrategies).values(seededRow).returning();
      await expect(owner.db.insert(schema.communityStrategies).values(seededRow)).rejects.toThrow();
      // the same pair is fine for an organisation's own entry
      await inOrg((tx) => tx.insert(schema.communityStrategies).values(entry({ optionKind: "custom" })));

      const seen = await inOther((tx) => tx.select().from(schema.communityStrategies));
      expect(seen.map((r) => r.id)).toContain(row!.id);
      const touched = await inOrg((tx) =>
        tx
          .update(schema.communityStrategies)
          .set({ title: "Mine now" })
          .where(eq(schema.communityStrategies.id, row!.id))
          .returning(),
      );
      expect(touched).toEqual([]);
    });

    it("gives every floor a layout, and only the two that exist", async () => {
      const floors = await inOrg((tx) => tx.select().from(schema.floors));
      expect(new Set(floors.map((f) => f.layout))).toEqual(new Set(["open_plan"]));
      const id = floors[0]!.id;
      await rolledBack(async (tx) => {
        await tx.update(schema.floors).set({ layout: "meeting_rooms" }).where(eq(schema.floors.id, id));
      });
      await expect(
        inOrg((tx) =>
          tx
            .update(schema.floors)
            .set({ layout: "ballroom" as "open_plan" })
            .where(eq(schema.floors.id, id)),
        ),
      ).rejects.toThrow();
    });

    it("stores the language of a brief and an explanation, English by default", async () => {
      await rolledBack(async (tx) => {
        const [brief] = await tx
          .insert(schema.aiBriefs)
          .values({ orgId: seeded.orgId, buildingId: seeded.buildingId, promptVersion: "test", input: {} })
          .returning();
        expect(brief!.locale).toBe("en");
        const [zh] = await tx
          .insert(schema.aiBriefs)
          .values({
            orgId: seeded.orgId,
            buildingId: seeded.buildingId,
            locale: "zh",
            promptVersion: "test",
            input: {},
          })
          .returning();
        expect(zh!.locale).toBe("zh");
        const [f] = await tx.select({ id: schema.findings.id }).from(schema.findings).limit(1);
        const [e] = await tx
          .insert(schema.aiExplanations)
          .values({ orgId: seeded.orgId, findingId: f!.id, promptVersion: "test", input: {} })
          .returning();
        expect(e!.locale).toBe("en");
      });
    });
  });
});
