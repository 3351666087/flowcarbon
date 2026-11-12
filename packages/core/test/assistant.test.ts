import { describe, expect, it } from "vitest";
import {
  adoptTurn,
  areaBand,
  buildPlan,
  communityEntry,
  communitySummary,
  communityTitle,
  communityTurn,
  DEFAULT_ANNUAL_DAYS,
  DEFAULT_CAPEX,
  namesPlaceOrTenant,
  otherReply,
  type PlanFinding,
  type PlanInput,
  type PlanIntent,
  planReply,
  statesAmount,
  turnIn,
} from "../src";
import { floor } from "./helpers";

const row = (
  floorId: string,
  ruleId: PlanFinding["ruleId"],
  dayType: PlanFinding["dayType"],
  avoidableKwh: number,
): PlanFinding => ({ floorId, ruleId, dayType, avoidableKwh });

const floors = [floor("f1"), floor("f2"), floor("f3")];
const input: PlanInput = {
  window: { from: "2026-09-15", to: "2026-10-13" },
  totals: { kwh: 10_000, cost: 8_000, co2eKg: 5_810, avoidableKwh: 1_000, greenShare: 0.1 },
  findings: [
    row("f1", "hvac_unrequested_non_working", "weekend", 400),
    row("f2", "hvac_empty_floor", "weekend", 100),
    row("f1", "hvac_empty_floor", "workday", 200),
    row("f3", "full_floor_few_people", "workday", 150),
    row("f2", "lights_on_empty_night", "workday", 100),
    row("f3", "lights_on_empty_night", "weekend", 50),
  ],
  floors,
  basis: { observed: { workday: 20, weekend: 8, holiday: 0 }, annual: DEFAULT_ANNUAL_DAYS },
  capex: DEFAULT_CAPEX,
};
const intent = (over: Partial<PlanIntent> = {}): PlanIntent => ({
  kind: "plan",
  target: null,
  focus: "all",
  floors: [],
  unknownFloors: [],
  days: "all",
  ...over,
});
const en = { locale: "en", floors } as const;
const zh = { locale: "zh", floors } as const;
const share = (value: number) => ({ kind: "avoidable_share", value }) as const;
const plan = (target: PlanIntent["target"] = null) => buildPlan(input, { target, focus: "all" });

describe("the reply when no model writes one", () => {
  it("says a floor is not there, and a place cannot be picked out, which is not saying it is not there", () => {
    const unknown = { unknownFloors: ["F99"], unknownPlaces: ["lobby", "the east wing"] };
    expect(planReply(plan(), intent(unknown), en).reply).toMatch(
      /^This building has no F99\. I can only act on whole floors, so I can't pick out the lobby and the east wing\. /,
    );
    for (const [name, shown] of [
      ["room 301", "room 301"],
      ["upstairs", "upstairs"],
      ["Acme's office", "Acme's office"],
      ["zone B", "zone B"],
      ["LG", "LG"],
      ["desks", "the desks"],
    ])
      expect(planReply(plan(), intent({ unknownPlaces: [name!] }), en).reply).toContain(
        `so I can't pick out ${shown}.`,
      );
    expect(planReply(plan(), intent({ unknownPlaces: ["大堂"] }), zh).reply).toMatch(
      /^我只能按整层操作，没法单独处理大堂。/,
    );
  });

  it("states where the building stands, in both languages", () => {
    expect(planReply(plan(), intent(), en).reply).toBe(
      "Avoidable energy is 10% of what the building used over the last 28 days. Here are 3 ways to bring it down.",
    );
    expect(planReply(plan(), intent(), zh).reply).toBe(
      "最近 28 天，可避免能耗占总能耗的 10%。下面是 3 个降低的方案。",
    );
  });

  it("says plainly how each option stands against a target", () => {
    // 10 % is what it is now, so anything at all reaches 9.9 %
    const near = share(0.099);
    expect(planReply(plan(near), intent({ target: near }), en).reply).toContain(
      "Every option below is expected to reach 9.9% avoidable.",
    );
    const far = share(0.01);
    const none = planReply(plan(far), intent({ target: far }), en).reply;
    expect(none).toMatch(
      /None of them is expected to reach 1% avoidable on its own\. The closest is [\d.]+% short\.$/,
    );
    const cut = { kind: "energy_cut", value: 0.1 } as const;
    expect(planReply(plan(cut), intent({ target: cut }), zh).reply).toContain("达不到总能耗减少 10%");
  });

  it("names the options that reach a target and those that do not", () => {
    const target = share(0.055);
    const { reply } = planReply(plan(target), intent({ target }), en);
    expect(reply).toMatch(/\d of these \d options (is|are) expected to reach 5\.5% avoidable\./);
  });

  it("does not offer to go further without saying the target is already met", () => {
    const target = share(0.5);
    expect(planReply(plan(target), intent({ target }), en).reply).toContain(
      "That target is already met. These would take it further.",
    );
  });

  it("counts what is adopted, and keeps it apart from what the data recorded", () => {
    const stacked = { ...input, adoptedKwh: 500 };
    const target = share(0.07);
    const met = buildPlan(stacked, { target, focus: "all" });
    expect(planReply(met, intent({ target }), en).reply).toBe(
      "Avoidable energy is 10% of what the building used over the last 28 days. With what is already adopted, it is expected to be 6.3%. What is already adopted is expected to meet that target. These would take it further.",
    );
    expect(planReply(met, intent({ target }), zh).reply).toContain("算上已采纳的措施，预计降到 6.3%。");
    const asked = planReply(buildPlan(stacked), intent({ kind: "question" }), en).reply;
    expect(asked).toBe(
      "Over the last 28 days the building used 10,000 kWh, of which 1,000 kWh (10%) was avoidable. With what is already adopted, it is expected to be 6.3%.",
    );
  });

  it("gives every option a title and what it changes, with the saving marked as expected", () => {
    const reply = planReply(plan(), intent(), en);
    expect(reply.options.map((o) => o.title)).toEqual(["Weekends first", "Weekdays first", "Balanced"]);
    expect(reply.options[0]!.why).toBe(
      "Weekends: cool only floors that asked (F1 and F2). Expected to save 400 kWh over 28 days.",
    );
    const zhOption = planReply(plan(), intent(), zh).options[0]!;
    expect(zhOption.title).toBe("周末优先");
    expect(zhOption.why).toBe("F1、F2：周末节假日只给申请楼层供冷。预计 28 天节省 400 kWh。");
  });

  it("shortens a long list of floors", () => {
    const many = Array.from({ length: 7 }, (_, i) => floor(`f${i}`));
    const big = buildPlan({
      ...input,
      floors: many,
      findings: many.map((f) => row(f.id, "hvac_unrequested_non_working", "weekend", 100)),
    });
    const context = { locale: "en", floors: many } as const;
    expect(planReply(big, intent(), context).options[0]!.why).toContain("F0, F1, F2, F3 and 3 more");
    expect(planReply(big, intent(), { ...context, locale: "zh" }).options[0]!.why).toContain(
      "F0、F1、F2、F3等 7 层",
    );
  });

  it("answers a question with the building's figures, options or not", () => {
    const empty = buildPlan({ ...input, findings: [] });
    expect(planReply(empty, intent({ kind: "question" }), en).reply).toBe(
      "Over the last 28 days the building used 10,000 kWh, of which 1,000 kWh (10%) was avoidable.",
    );
    expect(planReply(empty, intent(), en).reply).toBe(
      "Nothing open matches that in the last 28 days of data, so there is nothing to change.",
    );
  });

  it("says when there is no data, and when a floor does not exist", () => {
    const blank = buildPlan({
      ...input,
      findings: [],
      totals: { kwh: 0, cost: 0, co2eKg: 0, avoidableKwh: 0, greenShare: 0 },
      basis: { ...input.basis, observed: { workday: 0, weekend: 0, holiday: 0 } },
    });
    expect(planReply(blank, intent(), zh).reply).toBe("这栋楼还没有数据，暂时无法给出方案。");
    const lost = planReply(plan(), intent({ unknownFloors: ["F99", "F98"] }), en).reply;
    expect(lost).toMatch(/^This building has no F99 and F98\. Avoidable energy/);
  });

  it("uses no em-dashes in either language", () => {
    const target = share(0.05);
    const texts = [en, zh].flatMap((c) => [
      planReply(plan(target), intent({ target }), c),
      otherReply(c.locale),
    ]);
    expect(JSON.stringify(texts)).not.toContain("—");
  });
});

describe("when the plan is not quite what was asked", () => {
  const empty = { ...buildPlan(input), options: [] };
  const elsewhere = { focus: "hvac" as const, floors: ["F10", "F9"], kwh: 1234 };
  const asked: PlanIntent = {
    kind: "command",
    target: null,
    focus: "lights",
    floors: [],
    unknownFloors: [],
    days: "all",
  };

  it("says what is open when nothing matched", () => {
    const en = planReply(empty, { ...asked, elsewhere }, { locale: "en", floors }).reply;
    expect(en).toContain("nothing to change");
    expect(en).toContain("cooling on F10 and F9");
    expect(en).toContain("1,234 kWh");
    const zh = planReply(empty, { ...asked, elsewhere }, { locale: "zh", floors }).reply;
    expect(zh).toContain("F10、F9 的空调");
    expect(zh).toContain("1,234 kWh");
    expect(`${en}${zh}`).not.toContain("—");
  });

  it("stays with that when there is nothing else either", () => {
    const { reply } = planReply(empty, asked, { locale: "en", floors });
    expect(reply).toBe(
      "Nothing open matches that in the last 28 days of data, so there is nothing to change.",
    );
  });

  it("does not pass options off as the temperature someone asked for", () => {
    const setpoint = { ...asked, focus: "hvac" as const, setpoint: true };
    const plan = buildPlan(input);
    const en = planReply(plan, setpoint, { locale: "en", floors }).reply;
    expect(en).toContain("I can't set a temperature.");
    expect(en).toContain("instead");
    expect(en).not.toContain("Here is what that would change");
    const zh = planReply(plan, setpoint, { locale: "zh", floors }).reply;
    expect(zh).toContain("我没法设定温度。");
    expect(zh).not.toContain("这样做的效果如下");
  });
});

describe("a turn in another language", () => {
  const typed = {
    prompt: "把可避免能耗降到 5%",
    intent: intent(),
    plan: plan(),
    reply: { reply: "x", options: [] },
  };

  it("keeps the person's words and tells the figures again in the words of the template", () => {
    expect(turnIn(typed, en)).toEqual({ prompt: typed.prompt, reply: planReply(plan(), intent(), en) });
  });

  it("names a turn no one typed in that language too", () => {
    const option = plan().options[0]!;
    const adopted = turnIn(
      {
        ...typed,
        intent: intent({ source: "board" } as Partial<PlanIntent>),
        plan: { ...plan(), options: [option] },
      },
      zh,
    );
    expect(adopted).toMatchObject({ prompt: "采纳周末优先", reply: { reply: "已从策略页采纳：周末优先。" } });
    const used = turnIn(
      {
        ...typed,
        intent: {
          ...intent(),
          source: "community",
          strategy: { alias: "LBNL Building 59", kind: "weekends", title: null },
        },
      },
      zh,
    );
    expect(used.prompt).toBe("使用 LBNL 59 号楼 的“周末优先”");
  });

  it("answers anything else with the polite line of that language", () => {
    expect(turnIn({ ...typed, plan: null }, zh).reply).toEqual(otherReply("zh"));
  });
});

describe("amounts in words", () => {
  it.each([
    ["节省三成电量"],
    ["能省下一半的可避免能耗"],
    ["省下两万度电"],
    ["三分之一的浪费"],
    ["百分之二十"],
    ["cuts waste in half"],
    ["saves about a third"],
    ["Expected to save ninety percent of everything."],
    ["two hundred kWh"],
    ["ten percent less"],
    ["doubles the green share"],
  ])("%s states one", (text) => {
    expect(statesAmount(text)).toBe(true);
  });

  it.each([
    ["Two options reach the target."],
    ["One floor stays lit."],
    ["The third floor comes first."],
    ["两个方案都可以"],
    ["十二楼最浪费"],
    ["效果十分明显"],
    ["F7 用了 1,200 千瓦时"],
  ])("%s does not", (text) => {
    expect(statesAmount(text)).toBe(false);
  });
});

describe("turns no one typed", () => {
  it("records adopting an option in the language asked for", () => {
    const p = plan();
    const option = p.options[0]!;
    expect(adoptTurn(p, option, en)).toMatchObject({
      prompt: "Adopt Weekends first",
      reply: { reply: "Adopted from the strategies page: Weekends first." },
    });
    expect(adoptTurn(p, option, zh).reply.options.map((o) => o.id)).toEqual(["weekends"]);
  });

  it("names a community strategy and what it would do here", () => {
    const only = [{ strategyId: "zone_only_non_working", floorShare: 1 }] as const;
    const p = buildPlan(input, { target: null, focus: "all", only });
    const source = { title: "Quiet weekends", alias: "East wing" };
    expect(communityTurn(p, source, en)).toMatchObject({
      prompt: 'Use "Quiet weekends" from East wing',
      reply: { reply: '"Quiet weekends" applied to this building would do this.' },
    });
    expect(communityTurn(p, source, zh).prompt).toBe("使用 East wing 的“Quiet weekends”");
    const none = communityTurn(buildPlan({ ...input, findings: [] }), source, en);
    expect(none.reply.reply).toBe('"Quiet weekends" has nothing to act on in this building right now.');
    expect(none.reply.options).toEqual([]);
  });
});

describe("what a publisher may not type", () => {
  const names = { labels: ["F7", "Live-1600"], tenants: ["Northwind Software", "星河科技有限公司"] };

  it.each([
    ["Northwind Software"],
    ["Northwind"],
    ["NorthwindSoftware"],
    ["Northwind-Software"],
    ["ＮＯＲＴＨＷＩＮＤ ＳＯＦＴＷＡＲＥ"],
    ["North\u200bwind Software"],
    ["Northwind weekends"],
    ["星河运营"],
    ["F7"],
    ["F 7 crew"],
    ["floor 7 crew"],
    ["level 9"],
    ["7F crew"],
    ["7楼物业"],
    ["七楼方案"],
    ["Seventh floor plan"],
    ["Live-1600 team"],
    ["L7 crew"],
    ["l-7 team"],
    ["Ｌ７ crew"],
    ["7th crew"],
    ["the 21st team"],
    ["seventh crew"],
    ["seven floor team"],
    ["seven-floor team"],
    ["twelve level crew"],
    ["7/F crew"],
    ["fl. 7 team"],
    ["lvl 7"],
    ["floor no. 7"],
    ["B2 crew"],
    ["七層方案"],
  ])("%s gives one away", (text) => {
    expect(namesPlaceOrTenant(text, names)).toBe(true);
  });

  it.each([
    ["Quiet Ops"],
    ["East wing"],
    ["Building 59 team"],
    ["二号楼物业"],
    ["Operations"],
    ["Weekdays first"],
    ["Second nature"],
    ["B2B energy"],
  ])("%s does not", (text) => {
    expect(namesPlaceOrTenant(text, names)).toBe(false);
  });
});

describe("what a building shares", () => {
  it("bands the area coarsely", () => {
    expect([1_000, 5_000, 12_000, 20_000, 49_999, 50_000].map(areaBand)).toEqual([
      "<5k",
      "5-10k",
      "10-20k",
      "20-50k",
      "20-50k",
      "50k+",
    ]);
  });

  it("holds a mix and a result, and no floor", () => {
    const p = plan();
    const entry = communityEntry(p, p.options[0]!, floors);
    expect(entry).toEqual({
      optionKind: "weekends",
      strategyMix: [{ strategyId: "zone_only_non_working", floorShare: 2 / 3 }],
      floorsCount: 3,
      areaBand: "<5k",
      result: {
        avoidableShareBefore: 0.1,
        avoidableShareAfter: 0.0625,
        energyCutPct: 4,
        basis: "expected",
        days: 28,
      },
    });
    expect(JSON.stringify(entry)).not.toMatch(/"f[123]"|F[123]/);
  });

  it("calls a community option custom", () => {
    const only = [{ strategyId: "auto_lights_off", floorShare: 1 }] as const;
    const p = buildPlan(input, { target: null, focus: "all", only });
    expect(communityEntry(p, p.options[0]!, floors).optionKind).toBe("custom");
    expect(communityTitle("custom", "zh")).toBe("共享策略");
  });

  it("keeps its share exact, so the mix takes as many floors on a building of the same size", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => floor(`f${i}`));
    const findings = twelve.map((f) => row(f.id, "hvac_unrequested_non_working", "weekend", 100));
    const source = buildPlan({ ...input, floors: twelve, findings: findings.slice(0, 5) });
    const { strategyMix } = communityEntry(source, source.options[0]!, twelve);
    const again = buildPlan(
      { ...input, floors: twelve, findings },
      { target: null, focus: "all", only: strategyMix },
    );
    expect(again.options[0]!.actions).toHaveLength(5);
  });

  it("summarises in the publisher's language, saying what the figures rest on", () => {
    const p = plan();
    const entry = communityEntry(p, p.options[0]!, floors);
    expect(communitySummary(entry, "en")).toBe(
      "Expected: avoidable share from 10% to 6.3%, 4% less energy. 3 floors, based on 28 days of data.",
    );
    expect(communitySummary(entry, "zh")).toBe(
      "预计：可避免占比从 10% 降到 6.3%，总能耗减少 4%。3 层楼，基于 28 天数据。",
    );
    const measured = { ...entry, result: { ...entry.result, basis: "measured" as const } };
    expect(communitySummary(measured, "en")).toMatch(/^Measured: /);
    expect(communitySummary(measured, "zh")).toMatch(/^实测：/);
  });

  it("agrees with a single floor and a single day", () => {
    const p = plan();
    const entry = communityEntry(p, p.options[0]!, floors);
    const one = { floorsCount: 1, result: { ...entry.result, days: 1 } };
    expect(communitySummary(one, "en")).toContain("1 floor, based on 1 day of data.");
  });
});
