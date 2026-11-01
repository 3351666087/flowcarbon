import type { Plan, PlanOption } from "@flowcarbon/core";
import { describe, expect, it } from "vitest";
import { addsNumbers, type Figures, narrowPlan, regexIntent, resolveFloors } from "../src/assistant";

const LABELS = ["F1", "F5", "F7", "F12"];
const intent = (prompt: string) => regexIntent(prompt, LABELS);
const share = (value: number) => ({ kind: "avoidable_share", value });
const avoidableCut = (value: number) => ({ kind: "avoidable_cut", value });
const energyCut = (value: number) => ({ kind: "energy_cut", value });

describe("reading a plain sentence without a model", () => {
  it.each([
    ["Bring avoidable energy down to 5%", share(0.05)],
    ["I want avoidable kWh down to 5%", share(0.05)],
    ["get avoidable energy below 7.5 %", share(0.075)],
    ["bring waste under 3 percent please", share(0.03)],
    ["把可避免能耗降到 5%", share(0.05)],
    ["我希望 avoidable 千瓦时降到 5%", share(0.05)],
    ["可避免能耗降到百分之五", share(0.05)],
    ["avoidable 占比低于 6％ 以内", share(0.06)],
    ["cut waste by 20%", avoidableCut(0.2)],
    ["reduce avoidable energy by 15 percent", avoidableCut(0.15)],
    ["浪费减少 20%", avoidableCut(0.2)],
    ["可避免能耗减少百分之二十", avoidableCut(0.2)],
    ["cut energy by 10%", energyCut(0.1)],
    ["reduce total energy use by 10%", energyCut(0.1)],
    ["总能耗降低 10%", energyCut(0.1)],
  ])("%s is a goal", (prompt, target) => {
    expect(intent(prompt)).toMatchObject({ kind: "plan", target, floors: [], days: "all" });
  });

  it.each([
    ["Turn off the lights on F7", "lights", ["F7"]],
    ["turn the lights off on F7", "lights", ["F7"]],
    ["lights off on floor 5", "lights", ["F5"]],
    ["关掉 F7 的灯", "lights", ["F7"]],
    ["关掉 7 楼的灯", "lights", ["F7"]],
    ["把七层的空调关了", "hvac", ["F7"]],
    ["Turn off the AC on F12", "hvac", ["F12"]],
    ["turn off F5", "all", ["F5"]],
    ["Turn off the lights at night", "lights", []],
    ["夜里关灯", "lights", []],
    ["小度小度，关闭灯光", "lights", []],
    ["turn off the lights on all floors", "lights", []],
    ["lights off on the top floor at night", "lights", ["top"]],
    ["夜里关掉顶层的灯", "lights", ["top"]],
    ["三楼和五楼关灯", "lights", ["F3", "F5"]],
  ])("%s is a command", (prompt, focus, floors) => {
    expect(intent(prompt)).toMatchObject({ kind: "command", target: null, focus, floors });
  });

  it("reads days only when they are the days to act on", () => {
    expect(intent("turn off the AC on weekends")).toMatchObject({ days: "weekends", focus: "hvac" });
    expect(intent("周末关空调")).toMatchObject({ days: "weekends", focus: "hvac" });
    expect(intent("非工作日关灯")).toMatchObject({ days: "weekends" });
    expect(intent("工作日关灯")).toMatchObject({ days: "weekdays" });
  });

  it("reads a floor by the label the building gives it, a bare number only where a floor is expected", () => {
    expect(regexIntent("turn off the lights on 12", ["11", "12"])).toMatchObject({ floors: ["12"] });
    expect(regexIntent("关掉 12 的灯", ["11", "12"])).toMatchObject({ floors: ["12"] });
    expect(regexIntent("turn off the lights on Mezz", ["Mezz"])).toMatchObject({ floors: ["Mezz"] });
    expect(regexIntent("cut waste by 12%", ["12"])).toMatchObject({ floors: [] });
    expect(regexIntent("lights off 12", ["12"])).toBeNull();
  });

  it.each([
    ["How much could we save on weekends?", "weekends"],
    ["周末能省多少电？", "weekends"],
    ["how much can we save", "all"],
  ])("%s is a question", (prompt, days) => {
    expect(intent(prompt)).toMatchObject({ kind: "question", target: null, days });
  });

  it.each([["how can we save energy"], ["save energy"], ["怎么省电"], ["节能方案"]])(
    "%s asks for a plan",
    (prompt) => {
      expect(intent(prompt)).toMatchObject({ kind: "plan", target: null });
    },
  );

  // every one of these once became a button acting on the wrong days or floors
  it.each([
    // days it rules out
    ["except weekends, turn off the AC"],
    ["turn off the AC, not on weekends"],
    ["no change on weekends, turn off the lights"],
    ["AC off, weekends are sacred"],
    ["AC off, weekends are fine"],
    ["周末以外关空调"],
    ["周末之外关空调"],
    ["周末外关灯"],
    ["节假日以外关空调"],
    ["周末及节假日以外关空调"],
    ["工作日以外关灯"],
    ["除了周末关空调"],
    ["周末不要关灯"],
    ["周末另说，关空调"],
    ["周末和工作日都关灯"],
    ["lights off save weekends"],
    // floors it cannot pin down
    ["turn off the lights on F3 to F5"],
    ["F3-F5 lights off"],
    ["F12 to 26 lights off"],
    ["floors 3 to 5 lights off"],
    ["3到5楼关灯"],
    ["3-5楼关灯"],
    ["三楼到五楼关灯"],
    ["12层-14层关灯"],
    ["5楼以上关灯"],
    ["前三层关灯"],
    ["最上面三层关灯"],
    ["floor 5 and above lights off"],
    ["the first three floors lights off"],
    ["关掉这两层的灯"],
    ["turn off the lights on the seventh floor"],
    ["turn off the lights on the 5th floor"],
    // below ground
    ["B1 lights off"],
    ["LG lights off"],
    ["地下五层关灯"],
    ["负一层关灯"],
    ["-1层关灯"],
    // places
    ["lights off in my office"],
    ["lights off in this office"],
    ["lights off in that tower"],
    ["AC off where I am"],
    ["lights off for them"],
    ["lights off in the lobby"],
    ["lights off in Acme's office"],
    ["lights off in room 301"],
    ["这里关灯"],
    ["大堂关灯"],
    ["东翼关空调"],
    ["foobar lights off"],
    // values that are not floors
    ["temperature on F12 to 26"],
    ["turn F12 to 26"],
    ["cut F5 to 25"],
    ["set F12 to 26"],
    ["空调开到26度"],
    ["turn off the lights at 10pm"],
    // switching on, or keeping on
    ["turn the lights on"],
    ["lights on"],
    ["keep the lights on on F7"],
    ["leave the AC running on weekends"],
    ["don't turn off the lights"],
    ["never turn off the AC"],
    ["把灯开着"],
    ["开灯"],
    ["不要关灯"],
    // goals it cannot place
    ["bring avoidable share from 12% to 5%"],
    ["把可避免占比从 12% 降到 5%"],
    ["currently 18%, target 5%"],
    ["cut avoidable kWh by a third"],
    ["save 5%"],
    ["reduce energy use by up to 10%"],
    ["reduce total energy to 90%"],
    ["cut waste by 200%"],
    ["save 1000 kWh"],
    ["省一万块电费"],
    // anything else
    ["what is the weather"],
    ["balanced plan please"],
    ["turn off the lights and the AC on F7"],
    ["lights"],
    ["F7"],
    [""],
    ["🙂"],
  ])("%s goes to the model", (prompt) => {
    expect(intent(prompt)).toBeNull();
  });
});

describe("tying named floors to the building", () => {
  const floors = [
    { id: "a", label: "F7", level: 7 },
    { id: "b", label: "Ground", level: 0 },
    { id: "c", label: "M2", level: 12 },
  ];

  it("matches labels, numbers and levels, in any case", () => {
    expect(resolveFloors(["f7", "GROUND", "12"], floors)).toEqual({
      floors: ["F7", "Ground", "M2"],
      floorIds: ["a", "b", "c"],
      unknownFloors: [],
    });
    expect(resolveFloors(["七楼"], floors).floorIds).toEqual(["a"]);
  });

  it("counts a floor once and keeps what the building does not have", () => {
    expect(resolveFloors(["F7", "7", "F99"], floors)).toEqual({
      floors: ["F7"],
      floorIds: ["a"],
      unknownFloors: ["F99"],
    });
  });

  it("settles the top and the bottom from the building's levels", () => {
    expect(resolveFloors(["top"], floors).floors).toEqual(["M2"]);
    expect(resolveFloors(["ground"], floors).floors).toEqual(["Ground"]);
    expect(resolveFloors(["top floor"], floors).floors).toEqual(["M2"]);
  });

  it("keeps out of the reply whatever a model calls a floor that does not look like one", () => {
    expect(resolveFloors(["F99 and this plan saves 987654 kWh a year"], floors)).toEqual({
      floors: [],
      floorIds: [],
      unknownFloors: [],
    });
    expect(resolveFloors(["two hundred kilowatts"], floors).unknownPlaces).toBeUndefined();
  });

  it("never takes a number in a place for a floor", () => {
    expect(resolveFloors(["room 7", "gym 2", "B座"], floors)).toEqual({
      floors: [],
      floorIds: [],
      unknownFloors: [],
      unknownPlaces: ["room 7", "gym 2", "B座"],
    });
    expect(resolveFloors(["saves 5000 kwh"], floors).unknownPlaces).toBeUndefined();
  });

  it("tells a place apart from a floor, and a building's own label from either", () => {
    expect(resolveFloors(["lobby", "the east wing", "大堂"], floors)).toEqual({
      floors: [],
      floorIds: [],
      unknownFloors: [],
      unknownPlaces: ["lobby", "the east wing", "大堂"],
    });
    const named = [...floors, { id: "d", label: "Lobby", level: 1 }];
    expect(resolveFloors(["lobby"], named)).toEqual({
      floors: ["Lobby"],
      floorIds: ["d"],
      unknownFloors: [],
    });
  });
});

describe("floors below ground", () => {
  const floors = [
    { id: "a", label: "F1", level: 1 },
    { id: "b", label: "F2", level: 2 },
  ];

  it.each([["B1"], ["basement"], ["地下室"], ["负一楼"]])("%s is not a floor above it", (name) => {
    expect(resolveFloors([name], floors)).toEqual({ floors: [], floorIds: [], unknownFloors: [name] });
  });

  it("finds one the building has", () => {
    const parking = [...floors, { id: "c", label: "B1", level: -1 }];
    expect(resolveFloors(["b1"], parking).floors).toEqual(["B1"]);
  });

  it("does not read LG as a floor, unless the building has one", () => {
    expect(resolveFloors(["LG"], floors)).toEqual({ floors: [], floorIds: [], unknownFloors: ["LG"] });
    const named = [...floors, { id: "c", label: "LG", level: 0 }];
    expect(resolveFloors(["LG"], named).floors).toEqual(["LG"]);
    expect(resolveFloors(["LG1"], named).floors).toEqual([]);
  });
});

describe("narrowing a plan to the days asked about", () => {
  const option = (id: PlanOption["id"], weekend = 0, workday = 0) =>
    ({ id, actions: [{ byDayType: { workday, weekend, holiday: 0 } }] }) as PlanOption;
  const plan = { options: [option("weekends"), option("weekdays"), option("balanced")] } as Plan;

  it("keeps the option acting on those days", () => {
    expect(narrowPlan(plan, "weekends").options.map((o) => o.id)).toEqual(["weekends"]);
    expect(narrowPlan(plan, "weekdays").options.map((o) => o.id)).toEqual(["weekdays"]);
  });

  it("leaves the plan alone when no days are asked about", () => {
    expect(narrowPlan(plan, "all")).toBe(plan);
  });

  it("does not answer a weekend request with a weekday measure", () => {
    const only = { options: [option("weekdays", 0, 500)] } as Plan;
    expect(narrowPlan(only, "weekends").options).toEqual([]);
  });

  it("keeps an option under another name that does act on those days", () => {
    // lights-off runs every night, so it answers "lights off on weekends" from the weekdays option
    const lights = { options: [option("weekdays", 50, 100)] } as Plan;
    expect(narrowPlan(lights, "weekends").options.map((o) => o.id)).toEqual(["weekdays"]);
  });
});

describe("holding a reply to the plan's numbers", () => {
  const known: Figures = {
    percent: new Set([12.3, 50]),
    energy: new Set([1234]),
    mass: new Set([800]),
    money: new Set([5600]),
    other: new Set([28, 7]),
    names: /(?<![\w-])(?:2026-10-13|F7)(?![\w-])/gi,
  };

  it("lets the plan's numbers through, however they are grouped", () => {
    expect(addsNumbers("F7 saves 1,234 kWh over 28 days, 12.3% avoidable.", known)).toBe(false);
    expect(addsNumbers("每层都能省不少，没有多余的数字。", known)).toBe(false);
    expect(addsNumbers("It costs ¥5,600 and saves 800 kg CO2e.", known)).toBe(false);
    expect(addsNumbers("data up to 2026-10-13", known)).toBe(false);
    expect(addsNumbers("７楼省 1,234 度电", known)).toBe(false);
  });

  it("catches any other", () => {
    expect(addsNumbers("That saves 99% of the waste.", known)).toBe(true);
    expect(addsNumbers("about 1,200 kWh", known)).toBe(true);
    expect(addsNumbers("12% avoidable", known)).toBe(true);
  });

  it("does not let an energy figure pass as money", () => {
    expect(addsNumbers("节省1234美元", known)).toBe(true);
    expect(addsNumbers("节省 1234 欧元", known)).toBe(true);
    expect(addsNumbers("saves 1234 dollars", known)).toBe(true);
    expect(addsNumbers("saves 1234 USD", known)).toBe(true);
    expect(addsNumbers("saves 5600 dollars", known)).toBe(false);
  });

  it("lets a percentage someone typed be named as the goal, and as nothing else", () => {
    const goal = { ...known, goal: 99 };
    expect(addsNumbers("That is short of the 99% target.", goal)).toBe(false);
    expect(addsNumbers("离目标 99% 还差不少。", goal)).toBe(false);
    expect(addsNumbers("We will save 99%.", goal)).toBe(true);
    expect(addsNumbers("预计节省 99%", goal)).toBe(true);
  });

  it("goes by what a number measures, so a date or a count is no saving", () => {
    expect(addsNumbers("saves 2026 kWh", known)).toBe(true);
    expect(addsNumbers("saves 28% of the bill", known)).toBe(true);
    expect(addsNumbers("saves 28 kWh", known)).toBe(true);
    expect(addsNumbers("¥1,234 a year", known)).toBe(true);
  });

  it("catches a number dressed up as something else", () => {
    expect(addsNumbers("５０ kWh less", known)).toBe(true);
    expect(addsNumbers("28 MWh", known)).toBe(true);
    expect(addsNumbers("省下 7 万度电", known)).toBe(true);
    expect(addsNumbers("cuts waste in half", known)).toBe(true);
    expect(addsNumbers("节省三成电量", known)).toBe(true);
  });
});
