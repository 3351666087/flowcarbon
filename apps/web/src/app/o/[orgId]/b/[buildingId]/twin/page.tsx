"use client";

import {
  DESK_TO_CEILING_M,
  DRIFT,
  driftC,
  evaluateTwin,
  occupiedPolicy,
  placePeople,
  policyForStrategies,
  seatOrder,
  type TwinPolicy,
  type TwinSeat,
  type TwinTemplate,
  twinLayout,
  twinPolicies,
} from "@flowcarbon/core/twin";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Info, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CountUp } from "@/components/before-after";
import { strategyName } from "@/components/finding-plan";
import { feel, tick } from "@/components/glass";
import { toast } from "@/components/toast";
import { planCaption, TwinLegend, TwinPlan } from "@/components/twin-plan";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Metric,
  PageHeader,
  Select,
} from "@/components/ui";
import { ApiError, api, unwrap } from "@/lib/api";
import { addDays, num, pct, todayIn } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, PAGES, useBuilding, useFloors, useIds, useMembership } from "@/lib/session";

/** Layouts picked by someone who may not save them: this browser's own, by floor. */
const LOCAL_LAYOUTS = "flowcarbon.twin.layouts";

function readLocal(): Record<string, TwinTemplate> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_LAYOUTS) ?? "{}");
  } catch {
    return {};
  }
}

function writeLocal(layouts: Record<string, TwinTemplate>) {
  try {
    localStorage.setItem(LOCAL_LAYOUTS, JSON.stringify(layouts));
  } catch {
    // storage unavailable: the layout lasts as long as the page
  }
}

/** The local hour (0–23) of an instant in a time zone. */
function hourIn(at: Date, timeZone: string): number {
  return (
    Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at)) % 24
  );
}

/** Weeks of history a floor with no recent count is started from. */
const TYPICAL_WEEKS = 4;

/** The same weekday as today, on or before the last day with data, then a week, two weeks… earlier. */
function sameWeekdays(lastDay: string, timeZone: string): string[] {
  const weekday = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();
  const back = (weekday(lastDay) - weekday(todayIn(timeZone)) + 7) % 7;
  const first = addDays(lastDay, -back);
  return Array.from({ length: TYPICAL_WEEKS }, (_, i) => addDays(first, -7 * i));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

interface LayoutChange {
  floorId: string;
  label: string;
  layout: TwinTemplate;
  was: TwinTemplate;
}

const pill = (on: boolean) =>
  clsx(
    "fc-press min-h-11 rounded-full px-3 text-sm font-medium sm:min-h-9",
    on ? "bg-accent-soft text-accent" : "text-muted hover:text-text",
  );

export default function TwinPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const role = useMembership()?.role;
  const timeZone = useBuilding().building?.timezone ?? "UTC";
  const qc = useQueryClient();
  const floors = useFloors();
  const overview = useQuery({
    queryKey: ["overview", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/overview", {
          params: { path: { orgId, buildingId } },
        }),
      ),
    refetchInterval: 60_000,
  });
  const measures = useQuery({
    queryKey: ["measures", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/measures", {
          params: { path: { orgId, buildingId } },
        }),
      ),
  });
  // what is shown for a floor ahead of, or instead of, what the building has saved
  const [local, setLocal] = useState<Record<string, TwinTemplate>>({});
  // the floors refresh here, in the mutation: an undo in the toast can run after this page has been left
  const save = useMutation({
    mutationFn: ({ floorId, layout }: LayoutChange) =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/buildings/{buildingId}/floors/{floorId}/layout", {
          params: { path: { orgId, buildingId, floorId } },
          body: { layout },
        }),
      ),
    onSuccess: (_saved, change) => {
      feel("confirm");
      const { floorId, label, layout, was } = change;
      toast(fill(t.twin.layoutSaved, { floor: label, template: t.twin.templates[layout] ?? layout }), {
        label: t.plan.undo,
        run: () => {
          setLocal((l) => ({ ...l, [floorId]: was }));
          save.mutate({ floorId, label, layout: was, was: layout });
        },
      });
    },
    onSettled: async (_saved, _error, { floorId }) => {
      await qc.invalidateQueries({ queryKey: ["floors", orgId, buildingId] });
      setLocal(({ [floorId]: _settled, ...rest }) => rest);
    },
  });

  const [pickedFloor, setPickedFloor] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Record<string, TwinPolicy>>({});
  // seats changed by hand, by floor and layout; anything else follows the live count
  const [edits, setEdits] = useState<Record<string, readonly string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const editor = can.editBuilding(role);
  useEffect(() => {
    if (!editor) setLocal(readLocal());
  }, [editor]);

  const rows = floors.data ?? [];
  const occupancy = useMemo(
    () => new Map((overview.data?.floors ?? []).map((f) => [f.floorId, f.occupancy])),
    [overview.data],
  );
  // open on a floor with someone on it, so there is something to see
  const floor =
    rows.find((f) => f.id === pickedFloor) ?? rows.find((f) => (occupancy.get(f.id) ?? 0) > 0) ?? rows[0];
  const floorId = floor?.id;
  const areaM2 = floor?.areaM2 ?? 0;
  const template: TwinTemplate = (floorId && local[floorId]) || floor?.layout || "open_plan";
  const live = (floorId && occupancy.get(floorId)) || 0;
  // no reading says nothing about who is there, and nobody is not the same as unknown: such a floor starts
  // from the median count at this hour on the same weekday in the last weeks with data, labelled as assumed
  const counted = !!overview.data?.floors.find((f) => f.floorId === floorId)?.at;
  const lastDay = overview.data?.asOf ?? null;
  const history = useQueries({
    queries: (!counted && floorId && lastDay ? sameWeekdays(lastDay, timeZone) : []).map((date) => ({
      queryKey: ["intervals", orgId, buildingId, floorId, date],
      queryFn: () =>
        unwrap(
          api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/floors/{floorId}/intervals", {
            params: { path: { orgId, buildingId, floorId: floorId! }, query: { date } },
          }),
        ),
      staleTime: 30 * 60_000,
    })),
  });
  const hour = hourIn(new Date(), timeZone);
  const typicalDays = history
    .map((q) => (q.data ?? []).filter((iv) => hourIn(new Date(iv.start), timeZone) === hour))
    .filter((ivs) => ivs.length)
    .map((ivs) => ivs.reduce((n, iv) => n + iv.occupancy, 0) / ivs.length);
  const historyPending = history.some((q) => q.isPending);
  // with no history either, half the desks: a stated guess, not a reading
  const typical = typicalDays.length ? Math.round(median(typicalDays)) : null;

  const layout = useMemo(() => twinLayout(areaM2, template), [areaM2, template]);
  const assumed = counted ? null : historyPending ? 0 : (typical ?? Math.round(layout.seats.length / 2));
  const start = assumed ?? live;
  const placed = useMemo(() => placePeople(layout, start, floorId ?? ""), [layout, start, floorId]);
  const key = `${floorId}:${template}`;
  const otherKey = `${floorId}:${template === "open_plan" ? "meeting_rooms" : "open_plan"}`;
  // another layout has other seats, and the same number of people to put in them
  const people =
    edits[key] ?? (edits[otherKey] ? placePeople(layout, edits[otherKey].length, floorId ?? "") : placed);

  if (floors.isPending || overview.isPending) return <Loading page />;
  if (floors.error) return <ErrorBox error={floors.error} onRetry={() => floors.refetch()} />;
  if (overview.error) return <ErrorBox error={overview.error} onRetry={() => overview.refetch()} />;

  const header = <PageHeader title={t.twin.title} subtitle={t.twin.subtitle} />;
  // the nav hides the page from these roles, and a link should not open it anyway
  if (role && !PAGES.twin?.includes(role)) return <ErrorBox error={new ApiError({ status: 403 })} />;
  if (!floor)
    return (
      <>
        {header}
        <Empty>{t.twin.noFloors}</Empty>
      </>
    );

  const active = (measures.data?.items ?? []).filter(
    (m) => m.status === "in_effect" && m.floorId === floor.id,
  );
  const matched = policyForStrategies(
    template,
    active.map((m) => m.strategyId),
  );
  const offered = twinPolicies(template);
  const picked = policies[floor.id];
  const policy = picked && offered.includes(picked) ? picked : (matched ?? occupiedPolicy(template));
  // a cooling measure picks a policy that follows people too, so each line says which kind it is
  const kindOf = (id: string) =>
    id === "occupancy_gated_workday" || id === "zone_only_non_working"
      ? "cooling"
      : id === "auto_lights_off"
        ? "lighting"
        : "other";
  const inEffect = (["cooling", "lighting", "other"] as const)
    .map((kind) => ({
      kind,
      names: [
        ...new Set(
          active.filter((m) => kindOf(m.strategyId) === kind).map((m) => strategyName(t, m.strategyId)),
        ),
      ],
    }))
    .filter((x) => x.names.length);

  const before = evaluateTwin(floor, layout, "all_on", people);
  const after = evaluateTwin(floor, layout, policy, people);
  const worst = after.worstSeat;
  const focusId = selected && people.includes(selected) ? selected : (worst?.seatId ?? null);
  const focus = layout.seats.find((s) => s.id === focusId);
  const seatBefore = before.seats.find((s) => s.seatId === focusId)?.brightness ?? 0;
  const seatAfter = after.seats.find((s) => s.seatId === focusId)?.brightness ?? 0;
  const zonesOff = layout.zones.length - after.fanCoilsOn;

  const kw = (v: number) => `${num(v, locale, 1)} kW`;
  const celsius = (v: number) => `${num(v, locale, 1)} °C`;
  const seatName = (seat: TwinSeat) =>
    fill(template === "open_plan" ? t.twin.seatRow : t.twin.seatRoom, {
      group: layout.groups.find((g) => g.id === seat.group)?.index ?? "",
      seat: seat.index,
    });
  const worstSeat = layout.seats.find((s) => s.id === worst?.seatId);
  const change = after.before.totalKw
    ? (after.after.totalKw - after.before.totalKw) / after.before.totalKw
    : 0;
  const changeText = `${change < 0 ? "−" : ""}${num(Math.abs(change) * 100, locale)} %`;
  // with nobody seated the change is only the policy switching everything off, which says nothing useful
  const powerSub = people.length
    ? fill(t.twin.powerSub, { before: kw(after.before.totalKw), change: changeText })
    : fill(t.twin.wasAll, { all: kw(after.before.totalKw) });
  const rowGap = layout.depth / layout.groups.length;

  const setPeople = (next: readonly string[]) => setEdits((e) => ({ ...e, [key]: next }));
  const pickSeat = (seatId: string) => {
    tick();
    if (!people.includes(seatId)) {
      setPeople([...people, seatId]);
      setSelected(seatId);
    } else if (selected === seatId) {
      setPeople(people.filter((id) => id !== seatId));
      setSelected(null);
    } else setSelected(seatId);
  };
  const seatNext = () => {
    const next = seatOrder(layout, floor.id).find((id) => !people.includes(id));
    if (!next) return;
    tick();
    setPeople([...people, next]);
    setSelected(next);
  };
  const removeLast = () => {
    const last = people[people.length - 1];
    if (!last) return;
    tick();
    setPeople(people.slice(0, -1));
    if (selected === last) setSelected(null);
  };
  const resetPeople = () => {
    tick();
    setSelected(null);
    setEdits(({ [key]: _here, [otherKey]: _there, ...rest }) => rest);
  };

  const pickLayout = (next: TwinTemplate) => {
    if (next === template) return;
    tick();
    setSelected(null);
    if (editor) {
      setLocal((l) => ({ ...l, [floor.id]: next }));
      save.mutate({ floorId: floor.id, label: floor.label, layout: next, was: template });
    } else {
      const layouts = { ...local, [floor.id]: next };
      setLocal(layouts);
      writeLocal(layouts);
    }
  };

  return (
    <>
      {header}
      <p className="mb-4 flex items-start gap-2 rounded-2xl bg-surface-2 px-3 py-2.5 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        {t.twin.note}
      </p>

      <Card className="mb-4">
        <div className="grid gap-4 lg:grid-cols-[220px_auto_minmax(0,1fr)]">
          <Field label={t.twin.floor}>
            <Select
              className="min-h-11 sm:min-h-9"
              value={floor.id}
              onChange={(e) => {
                tick();
                setPickedFloor(e.target.value);
                setSelected(null);
              }}
            >
              {rows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="min-w-0 text-sm">
            <div className="font-medium">{t.twin.template}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(["open_plan", "meeting_rooms"] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  aria-pressed={x === template}
                  disabled={save.isPending}
                  onClick={() => pickLayout(x)}
                  className={pill(x === template)}
                >
                  {t.twin.templates[x]}
                </button>
              ))}
            </div>
            {editor ? null : <p className="mt-1 max-w-xs text-xs text-muted">{t.twin.layoutLocal}</p>}
          </div>
          <div className="min-w-0 text-sm">
            <div className="font-medium">{t.twin.policy}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {offered.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={p === policy}
                  onClick={() => {
                    tick();
                    setPolicies((all) => ({ ...all, [floor.id]: p }));
                  }}
                  className={pill(p === policy)}
                >
                  {t.twin.policies[p]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">{t.twin.policyHints[policy]}</p>
            {inEffect.map(({ kind, names }) => (
              <p key={kind} className="mt-1 text-xs text-saving">
                {fill(t.twin.inEffectKind[kind], { strategy: names.join(locale === "zh" ? "、" : ", ") })}
              </p>
            ))}
          </div>
        </div>
        {save.error ? (
          <div className="mt-3">
            <ErrorBox error={save.error} />
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card title={t.split.before} actions={<Badge>{t.twin.everythingOn}</Badge>} pad={false}>
          <div className="p-2">
            <TwinPlan
              layout={layout}
              result={before}
              state={t.split.before}
              people={people}
              selected={focusId}
              onPick={pickSeat}
              onNext={seatNext}
            />
          </div>
        </Card>
        <Card
          title={<span className="whitespace-nowrap text-saving">{t.split.after}</span>}
          actions={
            // on a phone the picker is in view just above; beside two plans the name may not fit, so it stops short
            <span className="hidden min-w-0 sm:inline-flex">
              <span className="min-w-0 truncate rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                {t.twin.policies[policy]}
              </span>
            </span>
          }
          pad={false}
        >
          <div className="p-2">
            <TwinPlan
              layout={layout}
              result={after}
              state={t.split.after}
              people={people}
              selected={focusId}
              worst={worst?.seatId}
              onPick={pickSeat}
              onNext={seatNext}
            />
          </div>
        </Card>
      </div>

      <p className="mt-2 text-xs text-muted">{t.twin.tapHint}</p>
      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <TwinLegend />
        <p className="num text-xs text-muted">
          {planCaption(layout, areaM2, { open: t.twin.planOpen, rooms: t.twin.planRooms }, locale)}
          {areaM2 > layout.areaM2 ? ` ${fill(t.twin.planCapped, { drawn: num(layout.areaM2, locale) })}` : ""}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted">{t.twin.people}</div>
              <div className="num mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{people.length}</div>
              <div className="num mt-1 text-xs text-muted">
                {counted ? fill(t.twin.live, { n: live }) : t.twin.noLive}
              </div>
              {assumed !== null && !historyPending ? (
                <div className="mt-0.5 text-xs font-medium text-accent">
                  {typical !== null
                    ? fill(t.twin.assumedTypical, { n: typicalDays.length })
                    : t.twin.assumedHalf}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                aria-label={t.twin.remove}
                title={t.twin.remove}
                className="min-h-11 min-w-11 px-0 sm:min-h-9 sm:min-w-9"
                disabled={!people.length}
                onClick={removeLast}
              >
                <Minus className="size-4" aria-hidden />
              </Button>
              <Button
                aria-label={t.twin.add}
                title={t.twin.add}
                className="min-h-11 min-w-11 px-0 sm:min-h-9 sm:min-w-9"
                disabled={people.length >= layout.seats.length}
                onClick={seatNext}
              >
                <Plus className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
          {people.length ? null : <p className="mt-3 text-xs text-muted">{t.twin.empty}</p>}
          {counted && live > layout.seats.length ? (
            <p className="mt-1 text-xs text-muted">
              {fill(t.twin.fewerDesks, { desks: layout.seats.length })}
            </p>
          ) : null}
          {edits[key] ? (
            <Button variant="ghost" className="mt-2 min-h-11 text-accent sm:min-h-9" onClick={resetPeople}>
              <RotateCcw className="size-3.5" aria-hidden /> {counted ? t.twin.reset : t.twin.resetAssumed}
            </Button>
          ) : null}
        </Card>

        <Card>
          {focus ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted">
                    {focusId === selected ? t.twin.selected : t.twin.darkest}
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold">{seatName(focus)}</div>
                </div>
                <Button
                  className="min-h-11 shrink-0 sm:min-h-9"
                  onClick={() => {
                    tick();
                    setPeople(people.filter((id) => id !== focus.id));
                    setSelected(null);
                  }}
                >
                  {t.twin.removeSeat}
                </Button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted">{t.split.before}</div>
                  <div className="num mt-0.5 text-xl font-semibold tracking-tight">
                    {pct(seatBefore, locale)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-saving">{t.split.after}</div>
                  <div className="num mt-0.5 text-xl font-semibold tracking-tight">
                    <CountUp value={seatAfter} from={seatBefore} format={(v) => pct(v, locale)} />
                  </div>
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-500"
                  style={{ width: `${Math.round(seatAfter * 100)}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">{t.twin.nobody}</p>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label={t.twin.lightsOn}
          value={
            <CountUp
              value={after.litFixtures}
              from={before.litFixtures}
              format={(v) => num(Math.round(v), locale)}
            />
          }
          sub={fill(t.twin.wasAll, { all: num(layout.fixtures.length, locale) })}
        />
        <Metric
          label={t.twin.fanCoilsOn}
          value={
            <CountUp
              value={after.fanCoilsOn}
              from={before.fanCoilsOn}
              format={(v) => num(Math.round(v), locale)}
            />
          }
          sub={fill(t.twin.wasAll, { all: num(layout.zones.length, locale) })}
        />
        <Metric
          label={t.twin.power}
          tone="saving"
          value={<CountUp value={after.after.totalKw} from={after.before.totalKw} format={kw} />}
          sub={powerSub}
        />
        <Metric
          label={t.twin.worstSeat}
          value={worst ? pct(worst.brightness, locale) : "–"}
          sub={worstSeat ? seatName(worstSeat) : t.twin.nobody}
        />
      </div>

      <div className="mt-3 space-y-1 text-xs text-muted">
        <p>
          {fill(t.twin.brightnessBasis, { height: num(DESK_TO_CEILING_M, locale, 1) })}{" "}
          {template === "open_plan"
            ? fill(t.twin.brightnessRows, { gap: num(rowGap, locale, 1) })
            : t.twin.brightnessRooms}
        </p>
        <p className="num">
          {fill(t.twin.powerBasis, {
            light: kw(floor.ratedLightingKw),
            cooling: kw(floor.ratedHvacKw),
            share: pct(floor.zoneOnlyFraction, locale),
          })}
        </p>
        {zonesOff > 0 ? (
          <p className="num">
            {fill(t.twin.drift, {
              n: zonesOff,
              one: celsius(driftC(1)),
              two: celsius(driftC(2)),
              settle: celsius(DRIFT.settleC),
              tau: num(DRIFT.tauHours, locale),
            })}
          </p>
        ) : null}
      </div>
    </>
  );
}
