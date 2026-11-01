import { optionTitle, type PlanLocale, percent } from "./assistant";
import { type FloorProfile, round } from "./model";
import type { MeasureStrategyMix, Plan, PlanOption } from "./plans";

export type CommunityOptionKind = "weekends" | "weekdays" | "balanced" | "custom";

/** The outcome a building publishes, with what it rests on. */
export interface CommunityResult {
  avoidableShareBefore: number;
  avoidableShareAfter: number;
  energyCutPct: number;
  basis: "expected" | "measured";
  /** days of data behind the figures */
  days: number;
  /** the building behind it is simulated, whatever its basis says */
  simulated?: boolean;
}

/** A published strategy as far as it can be derived from a plan. Nothing here names a floor or a tenant. */
export interface CommunityEntry {
  optionKind: CommunityOptionKind;
  strategyMix: MeasureStrategyMix;
  floorsCount: number;
  areaBand: string;
  result: CommunityResult;
}

const AREA_BANDS: readonly [number, string][] = [
  [5_000, "<5k"],
  [10_000, "5-10k"],
  [20_000, "10-20k"],
  [50_000, "20-50k"],
];

/** A building's size in m², coarse enough not to identify it. */
export function areaBand(areaM2: number): string {
  return AREA_BANDS.find(([limit]) => areaM2 < limit)?.[1] ?? "50k+";
}

/** Which strategies an option uses and on what share of the building's floors. The share stays exact for `only`. */
export function strategyMix(option: PlanOption, floors: number): MeasureStrategyMix {
  const counts = new Map<PlanOption["actions"][number]["strategyId"], number>();
  for (const a of option.actions) counts.set(a.strategyId, (counts.get(a.strategyId) ?? 0) + 1);
  return [...counts].map(([strategyId, n]) => ({ strategyId, floorShare: n / floors }));
}

/** What saving `savedKwh` over the plan's window comes to. */
export function communityResult(
  plan: Plan,
  savedKwh: number,
  basis: CommunityResult["basis"],
  days: number,
): CommunityResult {
  const { before } = plan;
  const kwh = before.kwh - savedKwh;
  return {
    avoidableShareBefore: round(before.avoidableShare, 4),
    avoidableShareAfter: round(kwh > 0 ? Math.max(0, before.avoidableKwh - savedKwh) / kwh : 0, 4),
    energyCutPct: before.kwh > 0 ? round((savedKwh / before.kwh) * 100, 1) : 0,
    basis,
    days,
  };
}

/** What a building shares of an option, with the planner's expected result. */
export function communityEntry(
  plan: Plan,
  option: PlanOption,
  floors: readonly Pick<FloorProfile, "areaM2">[],
): CommunityEntry {
  return {
    optionKind: option.id === "community" ? "custom" : option.id,
    strategyMix: strategyMix(option, floors.length),
    floorsCount: floors.length,
    areaBand: areaBand(floors.reduce((s, f) => s + f.areaM2, 0)),
    result: communityResult(plan, plan.before.kwh - option.after.kwh, "expected", plan.window.days),
  };
}

/** Width, case and invisible characters only change how a name looks. */
const plain = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "");
/** The same without spaces and punctuation, which is how a name gets past a literal comparison. */
const folded = (text: string) =>
  plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COUNTED =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
/** "first" and "second" alone are ordinary words (Weekdays first), so those two count only next to a word for a floor */
const ORDINAL =
  "third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth";
const STOREY = "(?:floors?|levels?|storeys?)";

/** A floor in any of the ways people write one, whether or not this building has it: a label is not the only way. */
const FLOOR_REFERENCE = new RegExp(
  [
    `\\b${STOREY}\\s*(?:no\\.?\\s*)?[-#]?\\s*(?:\\d+|${COUNTED})\\b`,
    `\\b(?:\\d+|${COUNTED})[\\s/-]*(?:f|fl|${STOREY})\\b`,
    "\\b\\d+(?:st|nd|rd|th)\\b",
    `\\b(?:${ORDINAL})\\b`,
    "\\b(?:f|fl|flr|l|lv|lvl|b)\\s*\\.?\\s*[-#]?\\s*\\d+\\b",
    `\\b(?:first|second|top|ground)\\s+${STOREY}\\b`,
    "[\\d一二两三四五六七八九十百]+\\s*[楼层樓層]",
  ].join("|"),
  "i",
);

/** What sets a tenant apart in its name: its first word, the rest being what many businesses are called. */
function tenantMark(name: string): string {
  const first =
    plain(name)
      .trim()
      .split(/[\s,，.·]+/)[0] ?? "";
  if (/^\p{Script=Han}/u.test(first)) return first.slice(0, 2);
  return first.length >= 4 ? first : "";
}

/**
 * Whether a text a publisher typed gives away a floor or a tenant, however it is spelled: a tenant's name or the word
 * that marks it, a label of this building, or a floor written any other way.
 */
export function namesPlaceOrTenant(
  text: string,
  { labels = [], tenants = [] }: { labels?: readonly string[]; tenants?: readonly string[] },
): boolean {
  const shown = plain(text);
  const word = (name: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped(plain(name))}(?![\\p{L}\\p{N}])`, "iu").test(shown);
  const marks = tenants.flatMap((t) => [t, tenantMark(t)]).filter(Boolean);
  return (
    FLOOR_REFERENCE.test(shown) ||
    labels.some((label) => label.length > 1 && /\D/.test(label) && word(label)) ||
    marks.some((name) => folded(shown).includes(folded(name)))
  );
}

/** The title a strategy gets when the publisher gives none. */
export function communityTitle(kind: CommunityOptionKind, locale: PlanLocale): string {
  return optionTitle(kind === "custom" ? "community" : kind, locale);
}

/** The published summary. Always this template: free text from a model never reaches another organisation. */
export function communitySummary(
  entry: Pick<CommunityEntry, "floorsCount" | "result">,
  locale: PlanLocale,
): string {
  const { result: r, floorsCount } = entry;
  const before = percent(r.avoidableShareBefore);
  const after = percent(r.avoidableShareAfter);
  if (locale === "zh") {
    const basis = r.basis === "measured" ? "实测" : "预计";
    return `${basis}：可避免占比从 ${before} 降到 ${after}，总能耗减少 ${r.energyCutPct}%。${floorsCount} 层楼，基于 ${r.days} 天数据。`;
  }
  const basis = r.basis === "measured" ? "Measured" : "Expected";
  const floors = `${floorsCount} ${floorsCount === 1 ? "floor" : "floors"}`;
  const days = `${r.days} ${r.days === 1 ? "day" : "days"}`;
  return `${basis}: avoidable share from ${before} to ${after}, ${r.energyCutPct}% less energy. ${floors}, based on ${days} of data.`;
}
