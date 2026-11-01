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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { num, pct } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { can, PAGES, useFloors, useIds, useMembership } from "@/lib/session";

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
  // no reading says nothing about who is there: such a floor starts empty, and nothing claims it is
  const counted = !!overview.data?.floors.find((f) => f.floorId === floorId)?.at;

  const layout = useMemo(() => twinLayout(areaM2, template), [areaM2, template]);
  const placed = useMemo(() => placePeople(layout, live, floorId ?? ""), [layout, live, floorId]);
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
  const inEffect = [...new Set(active.map((m) => strategyName(t, m.strategyId)))];

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
            {inEffect.length ? (
              <p className="mt-1 text-xs text-saving">
                {fill(t.twin.inEffect, { strategy: inEffect.join(locale === "zh" ? "、" : ", ") })}
              </p>
            ) : null}
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
          <p className="mt-3 text-xs text-muted">{people.length ? t.twin.tapHint : t.twin.empty}</p>
          {counted && live > layout.seats.length ? (
            <p className="mt-1 text-xs text-muted">
              {fill(t.twin.fewerDesks, { desks: layout.seats.length })}
            </p>
          ) : null}
          {edits[key] ? (
            <Button variant="ghost" className="mt-2 min-h-11 text-accent sm:min-h-9" onClick={resetPeople}>
              <RotateCcw className="size-3.5" aria-hidden /> {t.twin.reset}
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
          sub={fill(t.twin.powerSub, { before: kw(after.before.totalKw), change: changeText })}
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
