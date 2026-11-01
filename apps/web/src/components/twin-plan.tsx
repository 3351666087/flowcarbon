"use client";

import type { TwinLayout, TwinResult } from "@flowcarbon/core/twin";
import { type MouseEvent, memo, useId, useMemo } from "react";
import { num } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";

/** Marks are drawn in metres; on a very long floor they grow so that they can still be seen. */
const unitOf = (layout: TwinLayout) => Math.max(1, layout.width / 49);
const POOL_M = 2.3;

/** Rooms, corridors, desks and fan coil outlines: what stays the same whatever the policy. */
const Fabric = memo(function Fabric({ layout }: { layout: TwinLayout }) {
  const unit = unitOf(layout);
  const walls = 0.14 * unit;
  const desk = 0.9 * unit;
  return (
    <>
      {layout.groups.map((g) =>
        g.kind === "row" ? null : (
          <rect
            key={g.id}
            x={g.x}
            y={g.y}
            width={g.width}
            height={g.depth}
            fill={g.kind === "corridor" ? "var(--surface)" : "none"}
            fillOpacity={0.35}
            stroke="var(--muted)"
            strokeOpacity={0.6}
            strokeWidth={walls}
          />
        ),
      )}
      {layout.groups.map((g) =>
        g.kind === "room" ? (
          <rect
            key={g.id}
            x={g.x + g.width * 0.18}
            y={g.y + g.depth / 2 - 0.35 * unit}
            width={g.width * 0.64}
            height={0.7 * unit}
            fill="var(--muted)"
            fillOpacity={0.2}
          />
        ) : null,
      )}
      {layout.seats.map((s) => (
        <rect
          key={s.id}
          x={s.x - desk / 2}
          y={s.y - desk / 2}
          width={desk}
          height={desk}
          rx={0.15 * unit}
          fill="var(--muted)"
          fillOpacity={0.3}
        />
      ))}
    </>
  );
});

/**
 * One side of the split: a floor plan seen from above, with a pool of light under each lit fitting and a tint on each
 * zone with its fan coil running. The whole plan is one button: a tap lands on the nearest desk, so the desks need not
 * be finger-sized on a phone. Keyboard presses seat the next person instead.
 */
export function TwinPlan({
  layout,
  result,
  state,
  people,
  selected,
  worst,
  onPick,
  onNext,
}: {
  layout: TwinLayout;
  result: TwinResult;
  /** what this side shows, for screen readers */
  state: string;
  people: readonly string[];
  selected: string | null;
  /** the darkest seat, ringed */
  worst?: string | null;
  onPick: (seatId: string) => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const pool = `twin-pool-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const unit = unitOf(layout);
  const lit = useMemo(() => new Set(result.litGroups), [result.litGroups]);
  const running = useMemo(() => new Set(result.zonesOn), [result.zonesOn]);
  const seated = useMemo(() => {
    const ids = new Set(people);
    return layout.seats.filter((s) => ids.has(s.id));
  }, [layout, people]);
  const rooms = layout.template === "meeting_rooms";

  const tap = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) {
      onNext();
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * layout.width;
    const y = ((e.clientY - box.top) / box.height) * layout.depth;
    let nearest = layout.seats[0];
    let best = Number.POSITIVE_INFINITY;
    for (const s of layout.seats) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    if (nearest) onPick(nearest.id);
  };

  return (
    <button
      type="button"
      onClick={tap}
      className="block w-full cursor-pointer overflow-hidden rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
    >
      <svg
        viewBox={`0 0 ${layout.width} ${layout.depth}`}
        className="block h-auto w-full"
        role="img"
        aria-label={fill(t.twin.planLabel, {
          state,
          lit: result.litFixtures,
          lights: layout.fixtures.length,
          people: people.length,
        })}
      >
        <defs>
          <radialGradient id={pool}>
            <stop offset="0" stopColor="var(--twin-lamp)" stopOpacity="0.85" />
            <stop offset="1" stopColor="var(--twin-lamp)" stopOpacity="0" />
          </radialGradient>
          {/* the model stops light at a wall, so the picture must too */}
          {rooms
            ? layout.groups.map((g) => (
                <clipPath key={g.id} id={`${pool}-${g.id}`}>
                  <rect x={g.x} y={g.y} width={g.width} height={g.depth} />
                </clipPath>
              ))
            : null}
        </defs>
        <rect width={layout.width} height={layout.depth} fill="var(--twin-floor)" />
        {layout.zones.map((z) => (
          <rect
            key={z.id}
            x={z.x}
            y={z.y}
            width={z.width}
            height={z.depth}
            fill="var(--accent)"
            opacity={running.has(z.id) ? 0.08 : 0}
            className="transition-opacity duration-500"
          />
        ))}
        {layout.fixtures.map((f) => (
          <circle
            key={f.id}
            cx={f.x}
            cy={f.y}
            r={POOL_M}
            fill={`url(#${pool})`}
            clipPath={rooms ? `url(#${pool}-${f.group})` : undefined}
            opacity={lit.has(f.group) ? 1 : 0}
            className="transition-opacity duration-500"
          />
        ))}
        {rooms
          ? null
          : layout.zones.map((z) => (
              <rect
                key={z.id}
                x={z.x}
                y={z.y}
                width={z.width}
                height={z.depth}
                fill="none"
                stroke="var(--muted)"
                strokeOpacity={0.35}
                strokeWidth={0.08 * unit}
                strokeDasharray={`${0.5 * unit} ${0.4 * unit}`}
              />
            ))}
        <Fabric layout={layout} />
        {layout.fixtures.map((f) => (
          <rect
            key={f.id}
            x={f.x - 0.32 * unit}
            y={f.y - 0.13 * unit}
            width={0.64 * unit}
            height={0.26 * unit}
            fill={lit.has(f.group) ? "var(--twin-lamp)" : "var(--muted)"}
            fillOpacity={lit.has(f.group) ? 1 : 0.45}
            stroke={lit.has(f.group) ? "var(--waste)" : "none"}
            strokeWidth={0.05 * unit}
          />
        ))}
        {layout.zones.map((z) => {
          const on = running.has(z.id);
          const r = 0.55 * unit;
          const x = z.x + z.width / 2;
          const y = z.y + z.depth / 2;
          const d = r * Math.SQRT1_2;
          return (
            <g
              key={z.id}
              fill="none"
              stroke={on ? "var(--accent)" : "var(--muted)"}
              strokeOpacity={on ? 1 : 0.8}
              strokeWidth={0.13 * unit}
            >
              {/* a disc of floor under it, so that it reads the same inside a pool of light as outside one */}
              <circle
                cx={x}
                cy={y}
                r={r * 1.25}
                fill="var(--twin-floor)"
                fillOpacity={0.85}
                stroke="none"
                className="transition-opacity duration-500"
                opacity={on ? 0 : 1}
              />
              <circle cx={x} cy={y} r={r} />
              <path d={`M${x - d} ${y - d}L${x + d} ${y + d}M${x - d} ${y + d}L${x + d} ${y - d}`} />
            </g>
          );
        })}
        {seated.map((s) => (
          <g key={s.id}>
            {s.id === worst ? (
              <circle
                cx={s.x}
                cy={s.y}
                r={1.05 * unit}
                fill="none"
                stroke="var(--waste)"
                strokeWidth={0.18 * unit}
              />
            ) : null}
            {s.id === selected ? (
              <circle
                cx={s.x}
                cy={s.y}
                r={1.05 * unit}
                fill="var(--surface)"
                stroke="var(--text)"
                strokeWidth={0.22 * unit}
              />
            ) : null}
            {/* the ring keeps a person apart from a lit desk, which in dark mode is as bright as they are */}
            <circle
              cx={s.x}
              cy={s.y}
              r={0.62 * unit}
              fill="var(--accent)"
              stroke="var(--surface)"
              strokeWidth={0.36 * unit}
              paintOrder="stroke"
            />
          </g>
        ))}
      </svg>
    </button>
  );
}

/** What the marks on a plan mean. */
export function TwinLegend() {
  const { t } = useI18n();
  const item = "inline-flex items-center gap-1.5";
  const fan = (stroke: string) => (
    <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
      <g fill="none" stroke={stroke} strokeWidth="1.3">
        <circle cx="6" cy="6" r="4.6" />
        <path d="M2.8 2.8l6.4 6.4M2.8 9.2l6.4-6.4" />
      </g>
    </svg>
  );
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <li className={item}>
        <span className="size-3 rounded-full bg-[var(--twin-lamp)]" aria-hidden />
        {t.twin.legendLight}
      </li>
      <li className={item}>
        <span className="size-3 rounded-full bg-accent" aria-hidden />
        {t.twin.legendPerson}
      </li>
      <li className={item}>
        {fan("var(--accent)")}
        {t.twin.legendFan}
      </li>
      <li className={item}>
        {fan("var(--muted)")}
        {t.twin.legendFanOff}
      </li>
    </ul>
  );
}

/** The plan in figures, in the reader's language. */
export function planCaption(
  layout: TwinLayout,
  floorAreaM2: number,
  template: { open: string; rooms: string },
  locale: "en" | "zh",
) {
  const rooms = layout.template === "meeting_rooms";
  return fill(rooms ? template.rooms : template.open, {
    area: num(floorAreaM2, locale),
    groups: layout.groups.filter((g) => g.kind !== "corridor").length,
    lights: num(layout.fixtures.length, locale),
    fans: layout.zones.length,
  });
}
