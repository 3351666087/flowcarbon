"use client";

import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Download, FileUp } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { feel } from "@/components/glass";
import { Button, Card, ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { num } from "@/lib/format";
import { fill, useI18n } from "@/lib/i18n";
import { useFloors, useIds } from "@/lib/session";

type Field = "time" | "floor" | "people" | "hvacKwh" | "lightingKwh" | "plugKwh" | "hvac" | "lights";

/** header names each column is recognised by (lower case, spaces and punctuation ignored) */
const ALIASES: Record<Field, string[]> = {
  time: ["time", "timestamp", "datetime", "date", "start", "时间", "时刻"],
  floor: ["floor", "level", "楼层", "层"],
  people: ["people", "occupancy", "occupants", "count", "persons", "人数", "在场人数"],
  hvacKwh: ["hvackwh", "hvac_kwh", "coolingkwh", "空调", "空调电量", "空调kwh"],
  lightingKwh: ["lightingkwh", "lighting_kwh", "lightkwh", "照明", "照明电量", "照明kwh"],
  plugKwh: ["plugkwh", "plug_kwh", "plugloadkwh", "插座", "插座电量", "插座kwh"],
  hvac: ["hvac", "hvacmode", "cooling", "空调状态", "供冷"],
  lights: ["lights", "lighting", "lightlevel", "灯光", "照明状态"],
};
const FIELDS = Object.keys(ALIASES) as Field[];
const key = (h: string) => h.toLowerCase().replace(/[\s_\-()（）]/g, "");
/** rows per request; well inside the API's limit */
const PART = 4_000;

interface Parsed {
  name: string;
  rows: Record<string, unknown>[];
  columns: Field[];
  floors: { label: string; known: boolean; rows: number }[];
  from: string;
  to: string;
}

const numberOr = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const s = v.trim().replace(/%$/, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const hvacOr = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (["off", "setback", "full"].includes(s)) return s;
  if (["on", "true", "开"].includes(s)) return "full";
  if (["false", "关"].includes(s)) return "off";
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Bringing data in by hand, beside the live feed: a CSV of floor intervals (for example last year's records, or a
 * public case dataset converted to these columns) is read in the browser, checked against the building's floors,
 * and sent in parts through the same ingestion path a gateway uses. Opportunities follow once it is processed.
 */
export function DataImport({ demo }: { demo: boolean }) {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const floors = useFloors();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ rows: number; skipped: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const d = t.dataImport;

  const read = async (file: File) => {
    setParsed(null);
    setResult(null);
    setError(null);
    setProblem(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      // a file the phone could not hand over (moved, or still downloading) says so instead of doing nothing
      feel("reject");
      return setProblem(d.unreadable);
    }
    const table = parseCsv(text);
    const [header, ...body] = table;
    if (!header || !body.length) return setProblem(d.empty);
    const index = new Map<Field, number>();
    header.forEach((h, i) => {
      const k = key(h);
      const field = FIELDS.find((f) => ALIASES[f].some((a) => key(a) === k));
      if (field && !index.has(field)) index.set(field, i);
    });
    if (!index.has("time") || !index.has("floor")) return setProblem(d.needColumns);
    const known = new Set((floors.data ?? []).map((f) => f.label.toLowerCase()));
    const perFloor = new Map<string, number>();
    const rows = body.map((cells) => {
      const cell = (f: Field) => (index.has(f) ? cells[index.get(f)!] : undefined);
      const floor = (cell("floor") ?? "").trim();
      perFloor.set(floor, (perFloor.get(floor) ?? 0) + 1);
      return {
        time: (cell("time") ?? "").trim(),
        floor,
        people: numberOr(cell("people")),
        hvacKwh: numberOr(cell("hvacKwh")),
        lightingKwh: numberOr(cell("lightingKwh")),
        plugKwh: numberOr(cell("plugKwh")),
        hvac: hvacOr(cell("hvac")),
        lights: numberOr(cell("lights")),
      };
    });
    // in time order per floor, which is how the parts carry people from one to the next
    rows.sort((a, b) => a.floor.localeCompare(b.floor) || a.time.localeCompare(b.time));
    // the range shown is that of the times that look like dates; the server skips the rest
    const times = rows
      .map((r) => r.time)
      .filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x))
      .sort();
    setParsed({
      name: file.name,
      rows: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))),
      columns: FIELDS.filter((f) => index.has(f)),
      floors: [...perFloor].map(([label, n]) => ({ label, known: known.has(label.toLowerCase()), rows: n })),
      from: times[0] ?? "",
      to: times.at(-1) ?? "",
    });
  };

  const run = async () => {
    if (!parsed) return;
    setError(null);
    setProgress(0);
    let carry: Record<string, { people?: number; hvac?: "off" | "setback" | "full"; lights?: number }> = {};
    let rows = 0;
    let skipped = 0;
    const id = crypto.randomUUID();
    try {
      for (let i = 0; i < parsed.rows.length; i += PART) {
        const r = await unwrap(
          api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/imports", {
            params: { path: { orgId, buildingId } },
            body: {
              rows: parsed.rows.slice(i, i + PART) as never,
              carry,
              key: `${id}-${i / PART}`,
              source: parsed.name,
            },
          }),
        );
        carry = r.carry;
        rows += r.rows;
        skipped += r.skipped.unknownFloor + r.skipped.badTime;
        setProgress(Math.min(1, (i + PART) / parsed.rows.length));
      }
      feel("confirm");
      setResult({ rows, skipped });
      setParsed(null);
      for (const k of ["health", "batches", "devices"]) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      feel("reject");
      setError(e);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card title={d.title}>
      <p className="text-sm text-muted">{d.intro}</p>
      {demo ? (
        <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">{d.demo}</p>
      ) : (
        <>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-accent">{d.columns}</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {FIELDS.map((f) => (
                <div key={f} className="contents">
                  <dt className="font-mono text-xs leading-5">{ALIASES[f][0]}</dt>
                  <dd className="text-xs leading-5 text-muted">{d.fields[f]}</dd>
                </div>
              ))}
            </dl>
          </details>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) read(file);
                e.target.value = "";
              }}
            />
            <Button variant="primary" onClick={() => input.current?.click()} disabled={progress !== null}>
              <FileUp className="size-4" aria-hidden /> {d.choose}
            </Button>
            <a
              href="/templates/flowcarbon-import-template.csv"
              download
              className="fc-press inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-medium"
            >
              <Download className="size-4" aria-hidden /> {d.template}
            </a>
          </div>
          {problem ? <p className="mt-3 text-sm text-danger">{problem}</p> : null}
          {parsed ? (
            <div className="mt-4 rounded-2xl bg-surface-2 p-3.5 text-sm">
              <p className="font-medium">{parsed.name}</p>
              <p className="mt-1 text-muted">
                {fill(d.summary, {
                  rows: num(parsed.rows.length, locale),
                  from: parsed.from,
                  to: parsed.to,
                })}
              </p>
              <p className="mt-1 text-xs text-muted">
                {d.found}: {parsed.columns.join(", ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {parsed.floors.map((f) => (
                  <span
                    key={f.label}
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      f.known ? "bg-accent-soft text-accent" : "bg-waste-soft text-waste",
                    )}
                    title={f.known ? undefined : d.unknownFloor}
                  >
                    {f.label || "–"} · {num(f.rows, locale)}
                  </span>
                ))}
              </div>
              {parsed.floors.some((f) => !f.known) ? (
                <p className="mt-2 text-xs text-waste">{d.unknownFloors}</p>
              ) : null}
              <div className="mt-3 flex items-center gap-3">
                <Button
                  variant="primary"
                  busy={progress !== null}
                  disabled={!parsed.floors.some((f) => f.known)}
                  onClick={run}
                >
                  {fill(d.start, { rows: num(parsed.rows.length, locale) })}
                </Button>
                {progress !== null ? (
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width]"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {result ? (
            <div className="mt-4 rounded-2xl bg-saving-soft p-3.5 text-sm">
              <p className="font-medium text-saving">
                {fill(d.done, { rows: num(result.rows, locale), skipped: num(result.skipped, locale) })}
              </p>
              <p className="mt-1 text-muted">{d.next}</p>
              <Link
                href={`/o/${orgId}/b/${buildingId}/findings`}
                className="mt-2 inline-block font-medium text-accent"
              >
                {d.toFindings}
              </Link>
            </div>
          ) : null}
          {error ? (
            <div className="mt-3">
              <ErrorBox error={error} />
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
