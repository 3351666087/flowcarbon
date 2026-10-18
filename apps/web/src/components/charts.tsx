"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { day, type Locale, num, time } from "@/lib/format";

const axis = { stroke: "var(--muted)", fontSize: 11, tickLine: false, axisLine: false } as const;
const grid = { stroke: "var(--border)", strokeDasharray: "3 3", vertical: false } as const;
const tooltip = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 12,
    color: "var(--text)",
  },
  labelStyle: { color: "var(--muted)" },
} as const;

export function DailyEnergyChart({
  data,
  locale,
  labels,
}: {
  data: { day: string; kwh: number; avoidable: number }[];
  locale: Locale;
  labels: { energy: string; avoidable: string };
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart
          data={data.map((d) => ({ ...d, base: Math.max(0, d.kwh - d.avoidable) }))}
          margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
        >
          <CartesianGrid {...grid} />
          <XAxis
            dataKey="day"
            {...axis}
            tickFormatter={(d: string) => day(d, locale, { day: "numeric", month: "numeric" })}
            minTickGap={16}
          />
          <YAxis {...axis} tickFormatter={(v: number) => `${num(v / 1000, locale, 0)}k`} width={44} />
          <Tooltip
            {...tooltip}
            labelFormatter={(d) => day(String(d), locale)}
            formatter={(v, name) => [
              `${num(Number(v), locale)} kWh`,
              name === "avoidable" ? labels.avoidable : labels.energy,
            ]}
          />
          {/* the grow-in animation runs on the main thread, right when a page is being rendered */}
          <Bar
            dataKey="base"
            stackId="e"
            fill="var(--chart-4)"
            name="energy"
            radius={[0, 0, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="avoidable"
            stackId="e"
            fill="var(--chart-2)"
            name="avoidable"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Legend
            formatter={(v) => (v === "avoidable" ? labels.avoidable : labels.energy)}
            iconType="square"
            wrapperStyle={{ fontSize: 12 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface IntervalPoint {
  start: string;
  occupancy: number;
  hvacOn: number;
  kwh: number;
}

/** One floor-day: HVAC running (shaded), people counted (line), energy per interval (bars). */
export function IntervalChart({
  data,
  locale,
  timeZone,
  highlight,
  labels,
}: {
  data: IntervalPoint[];
  locale: Locale;
  timeZone: string;
  highlight?: { from: string; to: string };
  labels: { people: string; hvac: string; kwh: string; flagged: string };
}) {
  const from = highlight ? Date.parse(highlight.from) : 0;
  const to = highlight ? Date.parse(highlight.to) : 0;
  const rows = data.map((d) => {
    const t = Date.parse(d.start);
    return {
      ...d,
      label: time(d.start, locale, timeZone),
      hvac: d.hvacOn,
      flagged: highlight && t >= from && t < to ? d.kwh : 0,
      other: highlight && t >= from && t < to ? 0 : d.kwh,
    };
  });
  return (
    <div className="w-full">
      <ResponsiveContainer height={272}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="label" {...axis} interval={11} />
          <YAxis yAxisId="kwh" {...axis} width={40} />
          <YAxis yAxisId="people" orientation="right" {...axis} width={32} allowDecimals={false} />
          <YAxis yAxisId="hvac" hide domain={[0, 1]} />
          <Tooltip
            {...tooltip}
            formatter={(v, name) => {
              if (name === "hvac") return [`${num(Number(v) * 100, locale)} %`, labels.hvac];
              if (name === "occupancy") return [num(Number(v), locale), labels.people];
              return [`${num(Number(v), locale, 2)} kWh`, labels.kwh];
            }}
          />
          <Area
            yAxisId="hvac"
            dataKey="hvac"
            type="stepAfter"
            fill="var(--accent-soft)"
            stroke="none"
            name="hvac"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="kwh"
            dataKey="other"
            stackId="k"
            fill="var(--chart-4)"
            name="kwh"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="kwh"
            dataKey="flagged"
            stackId="k"
            fill="var(--chart-2)"
            name="kwh"
            isAnimationActive={false}
          />
          <Line
            yAxisId="people"
            dataKey="occupancy"
            type="stepAfter"
            stroke="var(--chart-3)"
            strokeWidth={2}
            dot={false}
            name="occupancy"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
        {[
          {
            label: labels.hvac,
            swatch: "h-3 w-3 rounded-sm bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/30",
          },
          { label: labels.kwh, swatch: "h-3 w-3 rounded-sm bg-[var(--chart-4)]" },
          { label: labels.flagged, swatch: "h-3 w-3 rounded-sm bg-[var(--chart-2)]" },
          { label: labels.people, swatch: "h-0.5 w-4 bg-[var(--chart-3)]" },
        ].map((l) => (
          <li key={l.label} className="inline-flex items-center gap-1.5">
            <span className={l.swatch} aria-hidden /> {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CashflowChart({
  data,
  locale,
  labels,
}: {
  data: { year: number; ownerCumulative: number; escoCumulative: number }[];
  locale: Locale;
  labels: { owner: string; esco: string };
}) {
  return (
    <div className="h-60 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="year" {...axis} />
          <YAxis {...axis} tickFormatter={(v: number) => `${num(v / 1000, locale, 0)}k`} width={48} />
          <Tooltip
            {...tooltip}
            formatter={(v, name) => [
              num(Number(v), locale),
              name === "ownerCumulative" ? labels.owner : labels.esco,
            ]}
            labelFormatter={(y) => `Y${y}`}
          />
          <Legend
            formatter={(v) => (v === "ownerCumulative" ? labels.owner : labels.esco)}
            wrapperStyle={{ fontSize: 12 }}
          />
          <Line dataKey="ownerCumulative" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
          <Line dataKey="escoCumulative" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
