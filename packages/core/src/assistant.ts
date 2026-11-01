import { round } from "./model";
import type { Plan, PlanFocus, PlanOption, PlanOptionId, PlanStrategyId, PlanTarget } from "./plans";

export type PlanLocale = "en" | "zh";
export type PlanDays = "all" | "weekends" | "weekdays";

/** The prompt version of a turn no model was asked about. Only those stay out of the AI quota. */
export const NO_AI = "template";

/** What is open in a building where a request found nothing, so that an honest "nothing" can still lead somewhere. */
export interface OpenElsewhere {
  focus: PlanFocus;
  floors: string[];
  /** expected saving over the plan's window */
  kwh: number;
}

/** What a request to the assistant asks for. */
export interface PlanIntent {
  kind: "plan" | "command" | "question" | "other";
  target: PlanTarget;
  focus: PlanFocus;
  /** the floors it names, as the building labels them */
  floors: string[];
  /** the floors it names that the building does not have */
  unknownFloors: string[];
  /** the parts of a floor or of the building it names, which no plan can pick out because plans act on whole floors */
  unknownPlaces?: string[];
  /** the days it is about, which narrow the plan to the option acting on them */
  days: PlanDays;
  /** it asks for a temperature, which no option sets: the options are an alternative, not what was asked */
  setpoint?: boolean;
  /** nothing matched: what the building does have open */
  elsewhere?: OpenElsewhere;
}

/** An intent as stored on a turn, with where a turn that no one typed came from. */
export interface TurnIntent extends PlanIntent {
  source?: "board" | "community";
  /** the community strategy this turn tries out */
  communityId?: string;
  /** its use has been counted, so applying again after an undo does not count it twice */
  usesCounted?: boolean;
  /** that strategy as it was tried, to tell the turn again in another language; `title` is null for a templated one */
  strategy?: { alias: string; kind: "weekends" | "weekdays" | "balanced" | "custom"; title: string | null };
}

export interface OptionText {
  id: PlanOptionId;
  title: string;
  why: string;
}

export interface PlanReply {
  reply: string;
  options: OptionText[];
}

/** One measure an applied option stands on. */
export interface AppliedMeasure {
  measureId: string;
  floorId: string;
  strategyId: string;
  status: "planned" | "in_effect";
  /** it was already there, and applying only added findings to it */
  joined: boolean;
  /** findings it gained */
  linked: number;
  /** on a joined measure: those findings, which an undo gives back while the measure stays */
  findingIds?: string[];
}

export interface ReplyContext {
  locale: PlanLocale;
  floors: readonly { id: string; label: string }[];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const COPY = {
  en: {
    title: {
      weekends: "Weekends first",
      weekdays: "Weekdays first",
      balanced: "Balanced",
      community: "Shared strategy",
    },
    strategy: {
      zone_only_non_working: "Weekend cooling only where requested",
      occupancy_gated_workday: "After-hours cooling only while people are in",
      auto_lights_off: "Lights off on empty floors at night",
    },
    on: (what: string, floors: string) => `${what} on ${floors}`,
    separator: "; ",
    saves: (kwh: string, days: number) => `Expected to save ${kwh} kWh over ${plural(days, "day")}.`,
    noData: "This building has no data yet, so there is nothing to plan from.",
    unknownFloors: (floors: string) => `This building has no ${floors}.`,
    unknownPlaces: (places: string) => `I can only act on whole floors, so I can't pick out ${places}.`,
    // a name that stands on its own takes no "the": room 301, upstairs, Acme's office, my office, LG
    place: (name: string) => {
      const bare = name.replace(/^the\s+/i, "");
      return /\d|stairs$|['’]s\b|\b[A-Z]{1,3}$|^(?:my|our|your|their|this|that|these|those)\b/i.test(bare)
        ? bare
        : `the ${bare}`;
    },
    nothing: (days: number) =>
      `Nothing open matches that in the last ${plural(days, "day")} of data, so there is nothing to change.`,
    share: (share: string, days: number) =>
      `Avoidable energy is ${share} of what the building used over the last ${plural(days, "day")}.`,
    shareAdopted: (share: string) => `With what is already adopted, it is expected to be ${share}.`,
    summary: (kwh: string, avoidable: string, share: string, days: number) =>
      `Over the last ${plural(days, "day")} the building used ${kwh} kWh, of which ${avoidable} kWh (${share}) was avoidable.`,
    alreadyMet: "That target is already met. These would take it further.",
    alreadyMetAdopted:
      "What is already adopted is expected to meet that target. These would take it further.",
    allReach: (goal: string) => `Every option below is expected to reach ${goal}.`,
    someReach: (n: number, total: number, goal: string) =>
      `${n} of these ${total} options ${n === 1 ? "is" : "are"} expected to reach ${goal}.`,
    noneReach: (goal: string, short: string) =>
      `None of them is expected to reach ${goal} on its own. The closest is ${short} short.`,
    ways: (n: number) =>
      n === 1 ? "Here is one way to bring it down." : `Here are ${n} ways to bring it down.`,
    command: "Here is what that would change.",
    setpoint: "I can't set a temperature.",
    setpointInstead: "These would cut cooling instead.",
    elsewhereWhat: { all: "cooling and lights", hvac: "cooling", lights: "lights" },
    elsewhere: (what: string, floors: string, kwh: string, days: number) =>
      `What is open here is ${what} on ${floors}, expected to save ${kwh} kWh over ${plural(days, "day")}. Ask about that instead.`,
    goal: {
      avoidable_share: (pct: string) => `${pct} avoidable`,
      avoidable_cut: (pct: string) => `${pct} less avoidable energy`,
      energy_cut: (pct: string) => `${pct} less energy`,
    },
    other:
      'I can plan ways to cut this building\'s energy, compare them, and switch off lights or cooling on a floor. Try "bring avoidable energy down to 5%" or "lights off on the top floor at night".',
    adopted: (title: string) => `Adopted from the strategies page: ${title}.`,
    adoptPrompt: (title: string) => `Adopt ${title}`,
    usePrompt: (title: string, alias: string) => `Use "${title}" from ${alias}`,
    useReply: (title: string) => `"${title}" applied to this building would do this.`,
    useNothing: (title: string) => `"${title}" has nothing to act on in this building right now.`,
  },
  zh: {
    title: {
      weekends: "周末优先",
      weekdays: "工作日优先",
      balanced: "均衡方案",
      community: "共享策略",
    },
    strategy: {
      zone_only_non_working: "周末和节假日只给申请的楼层供冷",
      occupancy_gated_workday: "下班后有人才供冷",
      auto_lights_off: "夜间空楼层自动关灯",
    },
    on: (what: string, floors: string) => `${floors}：${what}`,
    separator: "；",
    saves: (kwh: string, days: number) => `预计 ${days} 天节省 ${kwh} kWh。`,
    noData: "这栋楼还没有数据，暂时无法给出方案。",
    unknownFloors: (floors: string) => `这栋楼没有 ${floors}。`,
    unknownPlaces: (places: string) => `我只能按整层操作，没法单独处理${places}。`,
    place: (name: string) => name,
    nothing: (days: number) => `最近 ${days} 天的数据里没有符合的待处理项，暂时不需要改动。`,
    share: (share: string, days: number) => `最近 ${days} 天，可避免能耗占总能耗的 ${share}。`,
    shareAdopted: (share: string) => `算上已采纳的措施，预计降到 ${share}。`,
    summary: (kwh: string, avoidable: string, share: string, days: number) =>
      `最近 ${days} 天，大楼用电 ${kwh} kWh，其中 ${avoidable} kWh（${share}）可以避免。`,
    alreadyMet: "这个目标已经达到，下面的方案还能再往下降。",
    alreadyMetAdopted: "已采纳的措施预计就能达到这个目标，下面的方案还能再往下降。",
    allReach: (goal: string) => `下面每个方案预计都能达到${goal}。`,
    someReach: (n: number, total: number, goal: string) =>
      `这 ${total} 个方案里预计有 ${n} 个能达到${goal}。`,
    noneReach: (goal: string, short: string) =>
      `单靠其中任何一个预计都达不到${goal}，最接近的还差 ${short}。`,
    ways: (n: number) => (n === 1 ? "下面是一个降低的方案。" : `下面是 ${n} 个降低的方案。`),
    command: "这样做的效果如下。",
    setpoint: "我没法设定温度。",
    setpointInstead: "下面这些方案可以减少供冷能耗。",
    elsewhereWhat: { all: "空调和照明", hvac: "空调", lights: "照明" },
    elsewhere: (what: string, floors: string, kwh: string, days: number) =>
      `目前能处理的是 ${floors} 的${what}，预计 ${days} 天节省 ${kwh} kWh，可以问问这个。`,
    goal: {
      avoidable_share: (pct: string) => `可避免占比 ${pct}`,
      avoidable_cut: (pct: string) => `可避免能耗减少 ${pct}`,
      energy_cut: (pct: string) => `总能耗减少 ${pct}`,
    },
    other:
      "我可以为这栋楼规划节能方案、比较方案，也可以关掉某层的灯或空调。试试“把可避免能耗降到 5%”或“夜里关掉顶层的灯”。",
    adopted: (title: string) => `已从策略页采用：${title}。`,
    adoptPrompt: (title: string) => `采用${title}`,
    usePrompt: (title: string, alias: string) => `使用 ${alias} 的“${title}”`,
    useReply: (title: string) => `“${title}”用在这栋楼的效果如下。`,
    useNothing: (title: string) => `“${title}”在这栋楼暂时没有可执行的内容。`,
  },
} as const;

/** A share as a person reads it: 0.123 as 12.3%. */
export function percent(share: number): string {
  return `${round(share * 100, 1)}%`;
}

const kwhText = (kwh: number, locale: PlanLocale) =>
  Math.round(kwh).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");

function floorList(labels: readonly string[], locale: PlanLocale): string {
  const shown = labels.slice(0, 4);
  const more = labels.length - shown.length;
  if (locale === "zh") return `${shown.join("、")}${more > 0 ? `等 ${labels.length} 层` : ""}`;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

export function optionTitle(id: PlanOptionId, locale: PlanLocale): string {
  return COPY[locale].title[id];
}

/** What an option changes and what that is expected to save, for a card with no model behind it. */
function optionWhy(plan: Plan, option: PlanOption, ctx: ReplyContext): string {
  const copy = COPY[ctx.locale];
  const label = new Map(ctx.floors.map((f) => [f.id, f.label]));
  const byStrategy = new Map<PlanStrategyId, string[]>();
  for (const a of option.actions) {
    const floors = byStrategy.get(a.strategyId);
    const floor = label.get(a.floorId) ?? "?";
    if (floors) floors.push(floor);
    else byStrategy.set(a.strategyId, [floor]);
  }
  const parts = [...byStrategy].map(([id, floors]) =>
    copy.on(copy.strategy[id], floorList(floors, ctx.locale)),
  );
  const saved = kwhText(plan.before.kwh - option.after.kwh, ctx.locale);
  return `${parts.join(copy.separator)}${ctx.locale === "zh" ? "。" : ". "}${copy.saves(saved, plan.window.days)}`;
}

const optionTexts = (plan: Plan, options: readonly PlanOption[], ctx: ReplyContext): OptionText[] =>
  options.map((o) => ({
    id: o.id,
    title: optionTitle(o.id, ctx.locale),
    why: optionWhy(plan, o, ctx),
  }));

function lead(plan: Plan, intent: PlanIntent, locale: PlanLocale): string[] {
  const copy = COPY[locale];
  const { recorded, before, window, options } = plan;
  // what the data recorded, then where adopted measures are expected to leave it
  const share = percent(recorded.avoidableShare);
  const adopted = plan.adoptedKwh > 0 ? [copy.shareAdopted(percent(before.avoidableShare))] : [];
  if (intent.kind === "question") {
    const used = kwhText(recorded.kwh, locale);
    return [copy.summary(used, kwhText(recorded.avoidableKwh, locale), share, window.days), ...adopted];
  }
  if (!options.length) {
    const { elsewhere } = intent;
    return [
      ...(intent.setpoint ? [copy.setpoint] : []),
      copy.nothing(window.days),
      ...(elsewhere
        ? [
            copy.elsewhere(
              copy.elsewhereWhat[elsewhere.focus],
              floorList(elsewhere.floors, locale),
              kwhText(elsewhere.kwh, locale),
              window.days,
            ),
          ]
        : []),
    ];
  }
  const context = [copy.share(share, window.days), ...adopted];
  if (intent.setpoint) return [copy.setpoint, ...context, copy.setpointInstead];
  if (intent.target) {
    if (plan.alreadyMet) return [...context, adopted.length ? copy.alreadyMetAdopted : copy.alreadyMet];
    const goal = copy.goal[intent.target.kind](percent(intent.target.value));
    const reached = options.filter((o) => o.reachesTarget).length;
    if (reached === options.length) return [...context, copy.allReach(goal)];
    if (reached > 0) return [...context, copy.someReach(reached, options.length, goal)];
    const short = Math.min(...options.map((o) => o.shortBy ?? Number.POSITIVE_INFINITY));
    return [...context, copy.noneReach(goal, percent(short))];
  }
  return [...context, intent.kind === "command" ? copy.command : copy.ways(options.length)];
}

/**
 * The reply when no model writes one: every figure comes from the plan, so it says what the model's reply would, only
 * less gracefully. It is what the assistant falls back on without a key, or when the model fails.
 */
export function planReply(plan: Plan, intent: PlanIntent, ctx: ReplyContext): PlanReply {
  const copy = COPY[ctx.locale];
  const parts = plan.window.days ? lead(plan, intent, ctx.locale) : [copy.noData];
  const places = (intent.unknownPlaces ?? []).map(copy.place);
  if (places.length) parts.unshift(copy.unknownPlaces(floorList(places, ctx.locale)));
  if (intent.unknownFloors.length)
    parts.unshift(copy.unknownFloors(floorList(intent.unknownFloors, ctx.locale)));
  return { reply: parts.join(ctx.locale === "zh" ? "" : " "), options: optionTexts(plan, plan.options, ctx) };
}

/** The one line for a request that is not about the building's energy. */
export function otherReply(locale: PlanLocale): PlanReply {
  return { reply: COPY[locale].other, options: [] };
}

/** The turn behind adopting an option straight from the strategies page. */
export function adoptTurn(plan: Plan, option: PlanOption, ctx: ReplyContext) {
  const title = optionTitle(option.id, ctx.locale);
  return {
    prompt: COPY[ctx.locale].adoptPrompt(title),
    reply: { reply: COPY[ctx.locale].adopted(title), options: optionTexts(plan, [option], ctx) } as PlanReply,
  };
}

/** The turn behind trying a community strategy on this building: no model, whatever the deployment. */
export function communityTurn(plan: Plan, source: { title: string; alias: string }, ctx: ReplyContext) {
  const copy = COPY[ctx.locale];
  return {
    prompt: copy.usePrompt(source.title, source.alias),
    reply: {
      reply: plan.options.length ? copy.useReply(source.title) : copy.useNothing(source.title),
      options: optionTexts(plan, plan.options, ctx),
    } as PlanReply,
  };
}

const DATASET_NAMES: Record<string, Record<PlanLocale, string>> = {
  "Simulated demo tower": { en: "Simulated demo tower", zh: "模拟演示大楼" },
  "LBNL Building 59": { en: "LBNL Building 59", zh: "LBNL 59 号楼" },
};

/** The name a seeded strategy appears under, in the reader's language. */
export const datasetName = (alias: string, locale: PlanLocale) => DATASET_NAMES[alias]?.[locale] ?? alias;

/**
 * A finished turn in another language. Its figures are the plan's, so only the words change, and the template can
 * always write those; what a model wrote stays with the language it was written in. A person's own prompt stays too.
 */
export function turnIn(
  turn: { prompt: string; intent: TurnIntent | null; plan: Plan | null; reply: PlanReply | null },
  ctx: ReplyContext,
): { prompt: string; reply: PlanReply | null } {
  const { prompt, intent, plan } = turn;
  if (!intent || !plan) return { prompt, reply: turn.reply && otherReply(ctx.locale) };
  const option = plan.options[0];
  if (intent.source === "board" && option) return adoptTurn(plan, option, ctx);
  if (intent.source === "community") {
    if (!intent.strategy) return { prompt, reply: turn.reply };
    const { alias, kind, title } = intent.strategy;
    const titled = title ?? optionTitle(kind === "custom" ? "community" : kind, ctx.locale);
    return communityTurn(plan, { title: titled, alias: datasetName(alias, ctx.locale) }, ctx);
  }
  return { prompt, reply: planReply(plan, intent, ctx) };
}

const ZH_DIGIT = "一二两三四五六七八九";
/** Quantities written out rather than in digits. A count of options or floors is fine; an amount is a figure. */
const NUMBER_WORDS = new RegExp(
  [
    // English amounts: a share, a multiple, or anything past what counts things
    "\\b(?:half|quarters?|thirds?|fifths?|tenths?)\\b(?!\\s+(?:floor|level|option))",
    "\\b(?:halv(?:e|es|ed|ing)|doubl(?:e|es|ed|ing)|tripl(?:e|es|ed|ing)|twice|thrice)\\b",
    "\\b(?:eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty)\\b",
    "\\b(?:hundreds?|thousands?|millions?|billions?|dozens?)\\b",
    "\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)[\\s-]+(?:percent|per\\s?cent|pct|kwh|mwh|kilowatts?|megawatts?|kw|kg|kilograms?|tonnes?|tons?|yuan|rmb|cny|dollars?|euros?|pounds?|times|fold|years?|months?|weeks?|days?|hours?)\\b",
    // Chinese the same: 三成, 三分之一, 一半, 两倍, 十二 and 两万, 三度电, but not 十分 or 十二楼
    `[${ZH_DIGIT}十几数半]成`,
    `[${ZH_DIGIT}十百千几数]+分之`,
    "一半|大半|过半|减半|近半|半数|翻倍|翻番",
    `[${ZH_DIGIT}十几数]+倍`,
    `[${ZH_DIGIT}几数]?十[${ZH_DIGIT}]?(?![${ZH_DIGIT}分楼层])`,
    `[${ZH_DIGIT}十几数]*(?:百|千(?!瓦)|万|亿)[${ZH_DIGIT}十百千万亿几数]*`,
    `[${ZH_DIGIT}十几数]+(?:度|千瓦时|元|块钱|吨|公斤|千克)`,
  ].join("|"),
  "i",
);

/** Whether a text states a quantity in words. */
export const statesAmount = (text: string) => NUMBER_WORDS.test(text.normalize("NFKC"));
