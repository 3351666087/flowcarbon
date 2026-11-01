import { describe, expect, it } from "vitest";
import {
  type ActiveMeasure,
  buildPlan,
  DEFAULT_ANNUAL_DAYS,
  DEFAULT_CAPEX,
  estimateStrategies,
  type PlanFinding,
  type PlanInput,
  type PlanOption,
  type PlanRequest,
  planMetrics,
  REALISATION,
  type RuleId,
  savesEnergy,
  splitFindings,
  type WindowFinding,
  weekAhead,
  weekCoverage,
  weeklySaving,
} from "../src";
import { floor } from "./helpers";

const row = (
  floorId: string,
  ruleId: RuleId,
  dayType: PlanFinding["dayType"],
  avoidableKwh: number,
): PlanFinding => ({ floorId, ruleId, dayType, avoidableKwh });

// weekends: zone_only_non_working 500; weekdays: occupancy_gated_workday 350 and auto_lights_off 150
const findings: PlanFinding[] = [
  row("f1", "hvac_unrequested_non_working", "weekend", 400),
  row("f2", "hvac_empty_floor", "weekend", 100),
  row("f1", "hvac_empty_floor", "workday", 200),
  row("f3", "full_floor_few_people", "workday", 150),
  row("f2", "lights_on_empty_night", "workday", 100),
  row("f3", "lights_on_empty_night", "weekend", 50),
];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  window: { from: "2026-09-15", to: "2026-10-13" },
  totals: { kwh: 10_000, cost: 8_000, co2eKg: 5_810, avoidableKwh: 1_000, greenShare: 0.1 },
  findings,
  floors: [floor("f1"), floor("f2"), floor("f3")],
  basis: { observed: { workday: 20, weekend: 8, holiday: 0 }, annual: DEFAULT_ANNUAL_DAYS },
  capex: DEFAULT_CAPEX,
  ...over,
});

const NO_TARGET: PlanRequest = { target: null, focus: "all" };
const pairs = (o: PlanOption | undefined) => o?.actions.map((a) => `${a.floorId}:${a.strategyId}`);
const byId = (plan: ReturnType<typeof buildPlan>, id: PlanOption["id"]) =>
  plan.options.find((o) => o.id === id);

describe("plan options", () => {
  it("offers weekends, weekdays and balanced, each from its own strategies, largest first", () => {
    const plan = buildPlan(input());
    expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
    expect(pairs(byId(plan, "weekends"))).toEqual(["f1:zone_only_non_working", "f2:zone_only_non_working"]);
    expect(pairs(byId(plan, "weekdays"))).toEqual([
      "f1:occupancy_gated_workday",
      "f3:occupancy_gated_workday",
      "f2:auto_lights_off",
      "f3:auto_lights_off",
    ]);
    expect(byId(plan, "weekends")!.actions[0]).toMatchObject({
      coveredKwh: 400,
      findings: 1,
      byDayType: { workday: 0, weekend: 400, holiday: 0 },
    });
  });

  it("balanced alternates between the two sides, starting with the larger, so neither dominates", () => {
    expect(pairs(byId(buildPlan(input()), "balanced"))).toEqual([
      "f1:zone_only_non_working",
      "f1:occupancy_gated_workday",
      "f2:zone_only_non_working",
      "f3:occupancy_gated_workday",
      "f2:auto_lights_off",
      "f3:auto_lights_off",
    ]);
    const weekdaysLarger = buildPlan(
      input({ findings: [...findings, row("f1", "hvac_empty_floor", "workday", 900)] }),
    );
    expect(byId(weekdaysLarger, "balanced")!.actions[0]!.strategyId).toBe("occupancy_gated_workday");
  });

  it("keeps a side going once the other runs out", () => {
    const plan = buildPlan(
      input({
        findings: [
          row("f1", "hvac_unrequested_non_working", "weekend", 100),
          row("f1", "hvac_empty_floor", "workday", 90),
          row("f2", "hvac_empty_floor", "workday", 80),
          row("f3", "hvac_empty_floor", "workday", 70),
        ],
      }),
    );
    expect(pairs(byId(plan, "balanced"))).toEqual([
      "f1:zone_only_non_working",
      "f1:occupancy_gated_workday",
      "f2:occupancy_gated_workday",
      "f3:occupancy_gated_workday",
    ]);
  });

  it("drops an option with no candidates, so one or two options is valid", () => {
    const weekdaysOnly = buildPlan(input({ findings: findings.filter((f) => f.dayType === "workday") }));
    expect(weekdaysOnly.options.map((o) => o.id)).toEqual(["weekdays"]);
    const weekendsOnly = buildPlan(
      input({ findings: [row("f1", "hvac_unrequested_non_working", "weekend", 400)] }),
    );
    expect(weekendsOnly.options.map((o) => o.id)).toEqual(["weekends"]);
  });

  it("leaves out an option that only repeats another", () => {
    // one candidate reaches the target, so balanced would be the weekends option under another name
    const plan = buildPlan(input(), { target: { kind: "avoidable_cut", value: 0.3 }, focus: "all" });
    expect(pairs(byId(plan, "weekends"))).toEqual(["f1:zone_only_non_working"]);
    expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays"]);
  });

  it("with no target takes candidates of at least 5 % of the option, at most 8", () => {
    const small = buildPlan(
      input({
        findings: [
          row("f1", "hvac_unrequested_non_working", "weekend", 960),
          row("f2", "hvac_unrequested_non_working", "weekend", 40),
        ],
      }),
    );
    expect(pairs(byId(small, "weekends"))).toEqual(["f1:zone_only_non_working"]);

    const floors = Array.from({ length: 12 }, (_, i) => floor(`f${i}`));
    const many = buildPlan(
      input({
        floors,
        findings: floors.map((f) => row(f.id, "hvac_unrequested_non_working", "weekend", 100)),
      }),
    );
    expect(byId(many, "weekends")!.actions).toHaveLength(8);
  });

  it("judges a balanced option's candidates within their side, so a smaller side still gets its turns", () => {
    const plan = buildPlan(
      input({
        findings: [
          ...["f1", "f2", "f3", "f4", "f5"].map((f) =>
            row(f, "hvac_unrequested_non_working", "weekend", 2_000),
          ),
          row("f1", "hvac_empty_floor", "workday", 500),
          row("f2", "hvac_empty_floor", "workday", 400),
          row("f3", "hvac_empty_floor", "workday", 300),
        ],
      }),
    );
    // the workday floors are under 5 % of the 11,200 kWh on offer, but not of their own 1,200
    expect(byId(plan, "balanced")!.actions.map((a) => a.strategyId)).toEqual([
      "zone_only_non_working",
      "occupancy_gated_workday",
      "zone_only_non_working",
      "occupancy_gated_workday",
      "zone_only_non_working",
      "occupancy_gated_workday",
      "zone_only_non_working",
      "zone_only_non_working",
    ]);
  });

  it("keeps a balanced option to 8 actions, half from each side while both last", () => {
    const floors = Array.from({ length: 12 }, (_, i) => floor(`f${i}`));
    const plan = buildPlan(
      input({
        floors,
        findings: floors.flatMap((f) => [
          row(f.id, "hvac_unrequested_non_working", "weekend", 100),
          row(f.id, "hvac_empty_floor", "workday", 90),
        ]),
      }),
    );
    const actions = byId(plan, "balanced")!.actions;
    expect(actions).toHaveLength(8);
    expect(actions.filter((a) => a.strategyId === "zone_only_non_working")).toHaveLength(4);
  });

  it("still takes the largest few when a tall building spreads the waste below 5 % a floor", () => {
    const floors = Array.from({ length: 30 }, (_, i) => floor(`f${i}`));
    const plan = buildPlan(
      input({
        floors,
        findings: floors.map((f) => row(f.id, "hvac_unrequested_non_working", "weekend", 10)),
      }),
    );
    expect(byId(plan, "weekends")!.actions).toHaveLength(8);
  });

  it("respects focus", () => {
    const hvac = buildPlan(input(), { target: null, focus: "hvac" });
    expect(hvac.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
    const strategies = hvac.options.flatMap((o) => o.actions.map((a) => a.strategyId));
    expect(new Set(strategies)).toEqual(new Set(["zone_only_non_working", "occupancy_gated_workday"]));

    const lights = buildPlan(input(), { target: null, focus: "lights" });
    expect(lights.options.map((o) => o.id)).toEqual(["weekdays"]);
    expect(pairs(lights.options[0])).toEqual(["f2:auto_lights_off", "f3:auto_lights_off"]);
  });

  it("respects floorIds, and keeps the whole building in the before figures", () => {
    const plan = buildPlan(input(), { target: null, focus: "all", floorIds: ["f1"] });
    expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
    const floors = plan.options.flatMap((o) => o.actions.map((a) => a.floorId));
    expect(new Set(floors)).toEqual(new Set(["f1"]));
    expect(plan.before.kwh).toBe(10_000);
    expect(buildPlan(input(), { ...NO_TARGET, floorIds: ["nope"] }).options).toEqual([]);
  });

  it("keeps every floor the person named, however little it holds, past the limits on a free choice", () => {
    const named = buildPlan(
      input({
        findings: [
          row("f3", "lights_on_empty_night", "workday", 1_000),
          row("f7", "lights_on_empty_night", "workday", 40),
        ],
      }),
      { target: null, focus: "lights", floorIds: ["f3", "f7"] },
    );
    expect(named.options[0]!.actions.map((a) => a.floorId)).toEqual(["f3", "f7"]);

    const floors = Array.from({ length: 10 }, (_, i) => floor(`f${i}`));
    const many = buildPlan(
      input({ floors, findings: floors.map((f) => row(f.id, "lights_on_empty_night", "workday", 10)) }),
      { target: null, focus: "lights", floorIds: floors.map((f) => f.id) },
    );
    expect(many.options[0]!.actions).toHaveLength(10);
  });

  it("runs a shared mix as a single community option, on the same share of this building's floors", () => {
    const plan = buildPlan(input(), {
      ...NO_TARGET,
      only: [
        { strategyId: "occupancy_gated_workday", floorShare: 1 / 3 },
        { strategyId: "auto_lights_off", floorShare: 1 },
      ],
    });
    expect(plan.options.map((o) => o.id)).toEqual(["community"]);
    expect(pairs(plan.options[0])).toEqual([
      "f1:occupancy_gated_workday",
      "f2:auto_lights_off",
      "f3:auto_lights_off",
    ]);
  });

  it("keeps a mix to the focus and floors asked for", () => {
    const only = [
      { strategyId: "zone_only_non_working", floorShare: 1 },
      { strategyId: "auto_lights_off", floorShare: 1 },
    ] as const;
    const lights = buildPlan(input(), { target: null, focus: "lights", only });
    expect(pairs(lights.options[0])).toEqual(["f2:auto_lights_off", "f3:auto_lights_off"]);
    const onFloor = buildPlan(input(), { target: null, focus: "all", only, floorIds: ["f2"] });
    expect(pairs(onFloor.options[0])).toEqual(["f2:auto_lights_off", "f2:zone_only_non_working"]);
  });
});

describe("plan targets", () => {
  const before = input().totals;

  it("avoidable_share: stops once after avoidable / after kWh is at or below the value", () => {
    const value = 0.075;
    const plan = buildPlan(input(), { target: { kind: "avoidable_share", value }, focus: "all" });
    const weekends = byId(plan, "weekends")!;
    // 400 kWh at 0.8 leaves 680 / 9680 = 7.02 %, so the second candidate is not needed
    expect(pairs(weekends)).toEqual(["f1:zone_only_non_working"]);
    expect(weekends.after.avoidableShare).toBeLessThanOrEqual(value);
    expect(weekends).toMatchObject({ reachesTarget: true, shortBy: null });
    expect(plan.alreadyMet).toBe(false);
  });

  it("avoidable_cut: stops once after avoidable is at or below before × (1 − value)", () => {
    const value = 0.4;
    const plan = buildPlan(input(), { target: { kind: "avoidable_cut", value }, focus: "all" });
    const weekends = byId(plan, "weekends")!;
    expect(weekends.actions).toHaveLength(2);
    expect(weekends.after.avoidableKwh).toBeLessThanOrEqual(before.avoidableKwh * (1 - value));
    expect(weekends.reachesTarget).toBe(true);
    const weekdays = byId(plan, "weekdays")!;
    expect(weekdays.after.avoidableKwh).toBeLessThanOrEqual(before.avoidableKwh * (1 - value));
    expect(weekdays.actions).toHaveLength(4);
  });

  it("energy_cut: stops once after kWh is at or below before × (1 − value), counting exactly on the line", () => {
    // 400 kWh at 0.8 is exactly 3.2 %, which floating point alone would call just short
    const plan = buildPlan(input(), { target: { kind: "energy_cut", value: 0.032 }, focus: "all" });
    const weekends = byId(plan, "weekends")!;
    expect(pairs(weekends)).toEqual(["f1:zone_only_non_working"]);
    expect(weekends.after.kwh).toBe(9_680);
    expect(weekends.reachesTarget).toBe(true);
  });

  it("says how far short an option falls, in the target's own terms", () => {
    const plan = buildPlan(input(), { target: { kind: "avoidable_share", value: 0.01 }, focus: "all" });
    const weekends = byId(plan, "weekends")!;
    expect(weekends.actions).toHaveLength(2);
    expect(weekends.reachesTarget).toBe(false);
    expect(weekends.shortBy).toBeCloseTo(600 / 9_600 - 0.01, 10);

    const cut = buildPlan(input(), { target: { kind: "avoidable_cut", value: 0.9 }, focus: "all" });
    expect(byId(cut, "weekends")!.shortBy).toBeCloseTo(0.9 - 0.4, 10);

    const energy = buildPlan(input(), { target: { kind: "energy_cut", value: 0.5 }, focus: "all" });
    expect(byId(energy, "weekends")!.shortBy).toBeCloseTo(0.5 - 0.04, 10);
  });

  it("with a target takes every candidate it needs, past the no-target limits", () => {
    const floors = Array.from({ length: 12 }, (_, i) => floor(`f${i}`));
    const plan = buildPlan(
      input({
        floors,
        findings: floors.map((f) => row(f.id, "hvac_unrequested_non_working", "weekend", 80)),
      }),
      { target: { kind: "avoidable_cut", value: 0.99 }, focus: "all" },
    );
    expect(byId(plan, "weekends")!.actions).toHaveLength(12);
  });

  it("reports no reach and no shortfall without a target", () => {
    expect(buildPlan(input()).options[0]).toMatchObject({ reachesTarget: false, shortBy: null });
    expect(buildPlan(input()).alreadyMet).toBe(false);
  });

  it("already met: says so and still lists the options, in full", () => {
    const plan = buildPlan(input(), { target: { kind: "avoidable_share", value: 0.2 }, focus: "all" });
    expect(plan.alreadyMet).toBe(true);
    expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
    expect(plan.options.every((o) => o.reachesTarget && o.shortBy === null)).toBe(true);
    expect(byId(plan, "weekends")!.actions).toEqual(byId(buildPlan(input()), "weekends")!.actions);
  });

  it("a cut of nothing avoidable is already met; the same request on an empty building is not", () => {
    const nothing = input({ findings: [], totals: { ...input().totals, avoidableKwh: 0 } });
    const target = { kind: "avoidable_cut", value: 0.5 } as const;
    expect(buildPlan(nothing, { target, focus: "all" }).alreadyMet).toBe(true);
    const empty = input({
      findings: [],
      totals: { kwh: 0, cost: 0, co2eKg: 0, avoidableKwh: 0, greenShare: 0 },
    });
    expect(buildPlan(empty, { target, focus: "all" }).alreadyMet).toBe(false);
  });
});

describe("what is already adopted", () => {
  const big = {
    totals: { kwh: 100_000, cost: 80_000, co2eKg: 58_100, avoidableKwh: 12_000, greenShare: 0.1 },
  };
  const target = { kind: "avoidable_share", value: 0.06 } as const;
  const weekends = row("f1", "hvac_unrequested_non_working", "weekend", 8_000);
  const weekdays = row("f2", "hvac_empty_floor", "workday", 4_000);

  it("the same target asked again, after the option that met it, is met", () => {
    const first = buildPlan(input({ ...big, findings: [weekends, weekdays] }), { target, focus: "all" });
    const option = byId(first, "weekends")!;
    expect(option.reachesTarget).toBe(true);
    expect(option.after.avoidableShare).toBeCloseTo(0.0598, 3);

    const again = buildPlan(input({ ...big, findings: [weekdays], adoptedKwh: 8_000 }), {
      target,
      focus: "all",
    });
    expect(again.alreadyMet).toBe(true);
    expect(again.before.avoidableShare).toBeCloseTo(option.after.avoidableShare, 6);
    expect(again.recorded.avoidableShare).toBe(0.12);
    expect(again.options.every((o) => o.reachesTarget && o.shortBy === null)).toBe(true);
  });

  it("an option starts from where the building stands, and its own saving is still its own", () => {
    const plan = buildPlan(input({ ...big, findings: [weekdays], adoptedKwh: 8_000 }));
    const option = byId(plan, "weekdays")!;
    expect(plan.adoptedKwh).toBe(8_000);
    expect(plan.before.kwh).toBe(100_000 - 6_400);
    expect(plan.before.kwh - option.after.kwh).toBe(4_000 * 0.8);
    expect(plan.before.kwh - option.low.kwh).toBe(4_000 * 0.6);
    expect(option.after.avoidableShare).toBeCloseTo((12_000 - 9_600) / (100_000 - 9_600), 6);
    expect(option.annualSavingKwh).toBe(
      byId(buildPlan(input({ ...big, findings: [weekdays] })), "weekdays")!.annualSavingKwh,
    );
  });

  it("measures a cut from what the window recorded", () => {
    const cut = { kind: "energy_cut", value: 0.06 } as const;
    expect(
      buildPlan(input({ ...big, findings: [weekdays], adoptedKwh: 8_000 }), { target: cut, focus: "all" })
        .alreadyMet,
    ).toBe(true);
    const more = { kind: "energy_cut", value: 0.08 } as const;
    const plan = buildPlan(input({ ...big, findings: [weekdays], adoptedKwh: 8_000 }), {
      target: more,
      focus: "all",
    });
    expect(plan.alreadyMet).toBe(false);
    expect(byId(plan, "weekdays")!.reachesTarget).toBe(true);
  });

  it("changes nothing when nothing is adopted", () => {
    const plan = buildPlan(input());
    expect(plan.before).toEqual(plan.recorded);
    expect(plan.adoptedKwh).toBe(0);
    expect(plan.measureIds).toEqual([]);
  });

  it("records the measures it rests on", () => {
    expect(buildPlan(input({ measureIds: ["m1", "m2"] })).measureIds).toEqual(["m1", "m2"]);
  });

  it("says whether a target holds at the cautious end of the range too", () => {
    const close = buildPlan(input(), { target: { kind: "avoidable_share", value: 0.075 }, focus: "all" });
    expect(byId(close, "weekends")).toMatchObject({ reachesTarget: true, reachesAtLow: false });
    const easy = buildPlan(input(), { target: { kind: "avoidable_share", value: 0.2 }, focus: "all" });
    expect(easy.options[0]).toMatchObject({ reachesTarget: true, reachesAtLow: true });
    expect(buildPlan(input()).options[0]).toMatchObject({ reachesAtLow: false });
  });

  it("an on-site check switches nothing, so it is not an expected saving", () => {
    expect(savesEnergy({ strategyId: "investigate_on_site" })).toBe(false);
    expect(savesEnergy({ strategyId: "auto_lights_off" })).toBe(true);
  });
});

describe("plan figures", () => {
  it("before is the window as it stands", () => {
    expect(buildPlan(input()).before).toEqual({
      kwh: 10_000,
      cost: 8_000,
      co2eKg: 5_810,
      avoidableKwh: 1_000,
      avoidableShare: 0.1,
      greenShare: 0.1,
    });
  });

  it("after is at the mid realisation, low and high at the ends, and the range holds the expected figure", () => {
    const weekends = byId(buildPlan(input()), "weekends")!;
    expect(REALISATION).toEqual({ low: 0.6, mid: 0.8, high: 0.95 });
    expect(weekends.after.kwh).toBe(9_600);
    expect(weekends.low.kwh).toBe(9_700);
    expect(weekends.high.kwh).toBe(9_525);
    expect(weekends.after.avoidableKwh).toBe(600);
    expect(weekends.low.avoidableKwh).toBe(700);
    expect(weekends.high.avoidableKwh).toBe(525);
    expect(weekends.high.avoidableShare).toBeLessThan(weekends.after.avoidableShare);
    expect(weekends.after.avoidableShare).toBeLessThan(weekends.low.avoidableShare);
    expect(buildPlan(input()).realisation).toEqual(REALISATION);
  });

  it("prices cost and CO2e at the building's blended rates, not a constant", () => {
    const dear = buildPlan(input({ totals: { ...input().totals, cost: 20_000, co2eKg: 2_000 } }));
    const weekends = byId(dear, "weekends")!;
    expect(weekends.after.cost).toBe(19_200);
    expect(weekends.after.co2eKg).toBe(1_920);
    expect(byId(buildPlan(input()), "weekends")!.after.cost).toBe(7_680);
  });

  it("green energy stays the same over a lower total, so its share rises", () => {
    const weekends = byId(buildPlan(input()), "weekends")!;
    expect(weekends.after.greenShare).toBeCloseTo(1_000 / 9_600, 10);
    expect(weekends.after.greenShare).toBeGreaterThan(0.1);
    expect(weekends.high.greenShare).toBeGreaterThan(weekends.after.greenShare);
    expect(planMetrics(input().totals, 9_999).greenShare).toBe(1);
  });

  it("annualises per day type like the strategy estimates, at the mid realisation", () => {
    const weekends = byId(buildPlan(input()), "weekends")!;
    const estimate = estimateStrategies(
      findings.filter((f) => f.dayType === "weekend" && f.ruleId !== "lights_on_empty_night"),
      input().floors,
      input().basis,
    ).find((e) => e.id === "zone_only_non_working")!;
    expect(estimate.annualKwh).toBe(6_500);
    expect(weekends.annualSavingKwh).toBe(5_200);
    expect(weekends.annualSavingCost).toBe(4_160);
  });

  it("counts a floor's hardware once, and integration once for the whole option", () => {
    const plan = buildPlan(
      input({
        findings: [
          row("f1", "hvac_empty_floor", "workday", 100),
          row("f1", "lights_on_empty_night", "workday", 100),
          row("f2", "lights_on_empty_night", "workday", 100),
        ],
      }),
    );
    const { perFloor, integrationFixed } = DEFAULT_CAPEX;
    const f1 = perFloor.doorCounters + perFloor.zoneValves + perFloor.lightingRelays;
    const f2 = perFloor.doorCounters + perFloor.lightingRelays;
    expect(byId(plan, "weekdays")!.capex).toBe(f1 + f2 + integrationFixed);
  });

  it("has no figure without an estimate in the building's currency, and everything else stands", () => {
    const priced = buildPlan(input());
    const unpriced = buildPlan(input({ capex: null }));
    for (const o of unpriced.options) expect(o.capex).toBeNull();
    expect(unpriced.options.map(({ capex: _capex, ...o }) => o)).toEqual(
      priced.options.map(({ capex: _capex, ...o }) => o),
    );
  });
});

describe("a finding counts once", () => {
  it("across an option's actions", () => {
    const repeated = findings.map((f) => ({ ...f }));
    const plan = buildPlan(input({ findings: [...findings, ...repeated] }));
    const covered = plan.options.map((o) => o.actions.reduce((s, a) => s + a.coveredKwh, 0));
    // two rows with the same values are two findings; the balanced option covers each exactly once
    expect(covered).toEqual([1000, 1000, 2000]);
    expect(byId(plan, "balanced")!.actions.reduce((s, a) => s + a.findings, 0)).toBe(12);
  });

  it("when a mix names a strategy twice", () => {
    const plan = buildPlan(input(), {
      ...NO_TARGET,
      only: [
        { strategyId: "auto_lights_off", floorShare: 1 },
        { strategyId: "auto_lights_off", floorShare: 1 },
      ],
    });
    expect(pairs(plan.options[0])).toEqual(["f2:auto_lights_off", "f3:auto_lights_off"]);
    expect(plan.options[0]!.after.kwh).toBe(10_000 - 150 * 0.8);
  });

  it("when two active measures on a floor both cover it", () => {
    const measures: ActiveMeasure[] = [
      {
        id: "m1",
        floorId: "f1",
        strategyId: "occupancy_gated_workday",
        originRuleId: "hvac_empty_floor",
        status: "planned",
      },
      {
        id: "m2",
        floorId: "f1",
        strategyId: "investigate_on_site",
        originRuleId: "hvac_empty_floor",
        status: "planned",
      },
    ];
    const { adopted } = splitFindings(
      [{ ...row("f1", "hvac_empty_floor", "workday", 200), status: "open", measureId: null }],
      measures,
    );
    expect(adopted.map((m) => m.findings)).toEqual([1, 0]);
  });
});

describe("what is still open", () => {
  const measure: ActiveMeasure = {
    id: "m1",
    floorId: "f1",
    strategyId: "occupancy_gated_workday",
    originRuleId: "hvac_empty_floor",
    status: "in_effect",
  };
  const finding = (
    base: PlanFinding,
    status: WindowFinding["status"] = "open",
    measureId: string | null = null,
  ): WindowFinding => ({ ...base, status, measureId });
  const f1Workday = row("f1", "hvac_empty_floor", "workday", 200);

  it("leaves findings no active measure covers open", () => {
    const { open, adopted } = splitFindings(
      findings.map((f) => finding(f)),
      [],
    );
    expect(open).toHaveLength(findings.length);
    expect(adopted).toEqual([]);
  });

  it("gives a measure its linked findings and any that came back under it", () => {
    const { open, adopted } = splitFindings(
      [
        finding(f1Workday, "fixed", "m1"),
        finding(f1Workday),
        finding(row("f2", "hvac_empty_floor", "workday", 40)),
        finding(row("f1", "lights_on_empty_night", "workday", 30)),
      ],
      [measure],
    );
    expect(open.map((f) => f.floorId + f.ruleId)).toEqual(["f2hvac_empty_floor", "f1lights_on_empty_night"]);
    expect(adopted[0]).toMatchObject({
      id: "m1",
      coveredKwh: 400,
      findings: 2,
      byDayType: { workday: 400, weekend: 0, holiday: 0 },
    });
  });

  it("honours a link even where the measure's strategy would not cover the finding", () => {
    const { open, adopted } = splitFindings(
      [finding(row("f1", "lights_on_empty_night", "workday", 30), "acknowledged", "m1")],
      [measure],
    );
    expect(open).toEqual([]);
    expect(adopted[0]!.coveredKwh).toBe(30);
  });

  it("an on-site check answers its kind of finding on any day", () => {
    const check: ActiveMeasure = { ...measure, strategyId: "investigate_on_site", status: "planned" };
    const { open } = splitFindings([finding(row("f1", "hvac_empty_floor", "weekend", 10))], [check]);
    expect(open).toEqual([]);
  });

  it("leaves out dismissed findings, and findings reviewed with no measure behind them", () => {
    const { open, adopted } = splitFindings(
      [
        finding(f1Workday, "dismissed"),
        finding(row("f2", "hvac_empty_floor", "workday", 40), "acknowledged"),
      ],
      [measure],
    );
    expect(open).toEqual([]);
    expect(adopted[0]!.findings).toBe(0);
  });
});

describe("a building with little or no data", () => {
  it("an empty building gets zeros, no options and no division by zero", () => {
    const plan = buildPlan(
      input({
        findings: [],
        totals: { kwh: 0, cost: 0, co2eKg: 0, avoidableKwh: 0, greenShare: 0 },
        floors: [],
        basis: { observed: { workday: 0, weekend: 0, holiday: 0 }, annual: DEFAULT_ANNUAL_DAYS },
      }),
      { target: { kind: "avoidable_share", value: 0.05 }, focus: "all" },
    );
    expect(plan).toMatchObject({
      before: { kwh: 0, cost: 0, co2eKg: 0, avoidableKwh: 0, avoidableShare: 0, greenShare: 0 },
      options: [],
      alreadyMet: false,
      window: { days: 0 },
    });
  });

  it("a building whose data ended is judged on the days it has, by kind of day", () => {
    // five workdays, then nothing: weekends were never seen, so they are not extrapolated
    const plan = buildPlan(
      input({
        window: { from: "2024-03-04", to: "2024-03-09" },
        findings: findings.filter((f) => f.dayType === "workday"),
        basis: { observed: { workday: 5, weekend: 0, holiday: 0 }, annual: DEFAULT_ANNUAL_DAYS },
      }),
    );
    expect(plan.window).toEqual({
      from: "2024-03-04",
      to: "2024-03-09",
      days: 5,
      observed: { workday: 5, weekend: 0, holiday: 0 },
    });
    // 450 kWh over 5 workdays is 90 a day over 250 workdays, at 0.8
    expect(byId(plan, "weekdays")!.annualSavingKwh).toBe(18_000);
  });

  it("a plan never takes a building below zero", () => {
    const after = planMetrics(input().totals, 20_000);
    expect(after).toMatchObject({ kwh: 0, avoidableKwh: 0, avoidableShare: 0, greenShare: 0, cost: 0 });
  });
});

describe("a week of an expected saving", () => {
  it("is the card's figure over seven days of its window, with the range and the blended rate", () => {
    expect(weeklySaving(971.6, 28, { kwh: 10_000, cost: 2_000 })).toEqual({
      kwh: 194.3,
      cost: 38.86,
      lowKwh: 145.7,
      highKwh: 230.8,
    });
  });

  it("goes by the days there are, and has nothing to say without any", () => {
    expect(weeklySaving(300, 21, { kwh: 100, cost: 50 }).kwh).toBe(80);
    expect(weeklySaving(300, 0, { kwh: 0, cost: 0 })).toEqual({ kwh: 0, cost: 0, lowKwh: 0, highKwh: 0 });
  });
});

describe("week ahead", () => {
  const history = {
    observed: { workday: 20, weekend: 8, holiday: 0 },
    kwh: { workday: 8_000, weekend: 1_600, holiday: 0 },
  };
  const days = [
    { date: "2026-10-16", dayType: "workday" },
    { date: "2026-10-17", dayType: "weekend" },
    { date: "2026-10-19", dayType: "holiday" },
  ] as const;

  it("gives each day the average of its kind, without and with the strategies, and a range", () => {
    const week = weekAhead(history, days, { workday: 400, weekend: 160, holiday: 0 });
    expect(week[0]).toEqual({
      date: "2026-10-16",
      dayType: "workday",
      basis: 20,
      withoutKwh: 400,
      withKwh: 384,
      lowKwh: 388,
      highKwh: 381,
    });
    expect(week[1]).toMatchObject({ basis: 8, withoutKwh: 200, withKwh: 184 });
  });

  it("with nothing covered both lines are the same", () => {
    const week = weekAhead(history, days, { workday: 0, weekend: 0, holiday: 0 });
    expect(week[0]).toMatchObject({ withoutKwh: 400, withKwh: 400, lowKwh: 400, highKwh: 400 });
  });

  it("marks a kind of day the window never saw instead of inventing a figure", () => {
    const week = weekAhead(history, days, { workday: 0, weekend: 0, holiday: 50 });
    expect(week[2]).toMatchObject({ dayType: "holiday", basis: 0, withoutKwh: 0, withKwh: 0 });
  });

  it("never goes below zero", () => {
    const week = weekAhead(history, days, { workday: 100_000, weekend: 0, holiday: 0 });
    expect(week[0]).toMatchObject({ withKwh: 0, lowKwh: 0, highKwh: 0 });
  });

  it("gives per-strategy coverage that recombines to the same line as asking again", () => {
    const plan = buildPlan(input());
    const weekdays = byId(plan, "weekdays")!;
    const covered = { workday: 0, weekend: 0, holiday: 0 };
    for (const a of weekdays.actions) {
      covered.workday += a.byDayType.workday;
      covered.weekend += a.byDayType.weekend;
    }
    const direct = weekAhead(history, days, covered);
    const rows = weekCoverage(plan).filter((c) => c.option === "weekdays");
    expect(rows.map((c) => c.strategyId).sort()).toEqual(["auto_lights_off", "occupancy_gated_workday"]);
    const none = weekAhead(history, days, { workday: 0, weekend: 0, holiday: 0 });
    none.forEach((day, i) => {
      const off = rows.reduce((s, c) => s + c.perDayKwh[day.dayType], 0);
      expect(day.withKwh - off).toBeCloseTo(direct[i]!.withKwh, 0);
    });
    expect(rows.find((c) => c.strategyId === "auto_lights_off")!.perDayKwh).toEqual({
      workday: 4,
      weekend: 5,
      holiday: 0,
    });
  });
});
