import { MINUTE, zonedTime } from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { BuildingContext } from "./context";
import { type IngestBatch, type IngestResult, ingestTelemetry, MAX_BATCH_ITEMS } from "./ingest";

/** most rows one import request may carry */
export const MAX_IMPORT_ROWS = 5_000;

const num = z.union([z.number(), z.null()]).optional();
/**
 * One row of an imported table: one floor during one interval (15 minutes by default). Everything but time and floor
 * is optional; a column left empty is not imported.
 */
export const importRowSchema = z.object({
  /** start of the interval: building-local "YYYY-MM-DD HH:MM[:SS]", or ISO 8601 with an offset */
  time: z.string().max(60),
  /** the floor's label as the building has it, e.g. F5 */
  floor: z.string().min(1).max(40),
  /** people on the floor */
  people: num,
  hvacKwh: num,
  lightingKwh: num,
  plugKwh: num,
  /** cooling: off / setback / full, or a number (0 = off, otherwise full) */
  hvac: z.union([z.enum(["off", "setback", "full"]), z.number(), z.null()]).optional(),
  /** lighting level, 0–1 or 0–100 % */
  lights: num,
});
export type ImportRow = z.infer<typeof importRowSchema>;

/** where each floor stood at the end of the rows sent before, so a long table can arrive in parts */
export const importCarrySchema = z.record(
  z.string(),
  z.object({
    people: z.number().optional(),
    hvac: z.enum(["off", "setback", "full"]).optional(),
    lights: z.number().optional(),
  }),
);
export type ImportCarry = z.infer<typeof importCarrySchema>;

export interface ImportResult {
  rows: number;
  skipped: { unknownFloor: number; badTime: number; unknownFloors: string[] };
  counts: Record<string, number>;
  batches: IngestResult[];
  carry: ImportCarry;
}

/** Parses a row's time in the building's zone; null when it is not a time. */
export function importTime(value: string, timeZone: string): number | null {
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (local) {
    const [, day, h, m] = local;
    const ts = zonedTime(day!, Number(h) * 60 + Number(m), timeZone);
    return Number.isFinite(ts) ? ts : null;
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value.trim())) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

const mode = (v: ImportRow["hvac"]): "off" | "setback" | "full" | null =>
  v === undefined || v === null ? null : typeof v === "number" ? (v > 0 ? "full" : "off") : v;
const level = (v: number | null | undefined) =>
  v === undefined || v === null ? null : Math.max(0, Math.min(1, v > 1 ? v / 100 : v));

/**
 * Imports a table of past (or ongoing) floor data next to the live feed: the devices it needs are created per floor
 * (IMPORT-…), people become door counts, energy becomes meter readings, cooling and lighting become events, and all
 * of it goes through the same ingestion path a gateway uses, so the recompute job turns it into intervals, findings
 * and forecasts. Rows for floors the building does not have, or with a time that cannot be read, are skipped and
 * counted.
 */
export async function importRows(
  tx: Tx,
  ctx: BuildingContext,
  input: { rows: ImportRow[]; carry?: ImportCarry; key: string },
): Promise<ImportResult> {
  const tz = ctx.building.timezone;
  const bucketMs = ctx.bucketMinutes * MINUTE;
  const floors = new Map(ctx.floors.map((f) => [f.label.toLowerCase(), f]));
  const unknown = new Set<string>();
  const skipped = { unknownFloor: 0, badTime: 0 };
  const byFloor = new Map<string, { at: number; row: ImportRow }[]>();
  for (const row of input.rows) {
    const floor = floors.get(row.floor.trim().toLowerCase());
    if (!floor) {
      skipped.unknownFloor++;
      unknown.add(row.floor.trim());
      continue;
    }
    const at = importTime(row.time, tz);
    if (at === null) {
      skipped.badTime++;
      continue;
    }
    const list = byFloor.get(floor.id) ?? [];
    list.push({ at: at - (at % bucketMs), row });
    byFloor.set(floor.id, list);
  }

  // devices: one of each kind a floor's columns need, named after the building and floor
  const tag = ctx.building.id.slice(0, 8);
  const ids = (label: string) => ({
    door: `IMPORT-${tag}-${label}-DOOR`,
    bms: `IMPORT-${tag}-${label}-AHU`,
    light: `IMPORT-${tag}-${label}-LIGHT`,
    meter: (system: string) => `IMPORT-${tag}-${label}-M-${system.toUpperCase()}`,
  });
  const wanted: (typeof schema.devices.$inferInsert)[] = [];
  for (const [floorId, list] of byFloor) {
    const label = ctx.floors.find((f) => f.id === floorId)!.label;
    const d = ids(label);
    const base = { orgId: ctx.orgId, buildingId: ctx.building.id, floorId, metadata: { source: "import" } };
    const has = (pick: (r: ImportRow) => unknown) =>
      list.some(({ row }) => pick(row) !== undefined && pick(row) !== null);
    if (has((r) => r.people))
      wanted.push({ ...base, kind: "door_counter", externalId: d.door, name: `${label} people (imported)` });
    if (has((r) => r.hvac))
      wanted.push({ ...base, kind: "bms_zone", externalId: d.bms, name: `${label} cooling (imported)` });
    if (has((r) => r.lights))
      wanted.push({
        ...base,
        kind: "lighting_controller",
        externalId: d.light,
        name: `${label} lighting (imported)`,
      });
    for (const [system, pick] of [
      ["hvac", (r: ImportRow) => r.hvacKwh],
      ["lighting", (r: ImportRow) => r.lightingKwh],
      ["plug", (r: ImportRow) => r.plugKwh],
    ] as const)
      if (has(pick))
        wanted.push({
          ...base,
          kind: "meter",
          system,
          externalId: d.meter(system),
          name: `${label} ${system} meter (imported)`,
        });
  }
  if (wanted.length) {
    const existing = await tx
      .select({ externalId: schema.devices.externalId })
      .from(schema.devices)
      .where(
        and(
          eq(schema.devices.orgId, ctx.orgId),
          inArray(
            schema.devices.externalId,
            wanted.map((w) => w.externalId),
          ),
        ),
      );
    const have = new Set(existing.map((e) => e.externalId));
    const missing = wanted.filter((w) => !have.has(w.externalId));
    if (missing.length) await tx.insert(schema.devices).values(missing);
  }

  const batch: IngestBatch = { readings: [], doorCounts: [], hvacEvents: [], lightingEvents: [] };
  const iso = (ts: number) => new Date(ts).toISOString();
  const carry: ImportCarry = { ...input.carry };
  for (const [floorId, list] of byFloor) {
    const label = ctx.floors.find((f) => f.id === floorId)!.label;
    const d = ids(label);
    list.sort((a, b) => a.at - b.at);
    const state = { ...carry[label] };
    for (const { at, row } of list) {
      if (row.people !== undefined && row.people !== null) {
        const people = Math.max(0, Math.round(row.people));
        const before = state.people ?? 0;
        batch.doorCounts.push({
          device: d.door,
          start: iso(at),
          entries: Math.max(0, people - before),
          exits: Math.max(0, before - people),
        });
        state.people = people;
      }
      for (const [system, kwh] of [
        ["hvac", row.hvacKwh],
        ["lighting", row.lightingKwh],
        ["plug", row.plugKwh],
      ] as const)
        if (kwh !== undefined && kwh !== null && kwh >= 0)
          batch.readings.push({ device: d.meter(system), start: iso(at), end: iso(at + bucketMs), kwh });
      const m = mode(row.hvac);
      if (m && m !== state.hvac) {
        batch.hvacEvents.push({ device: d.bms, at: iso(at), mode: m });
        state.hvac = m;
      }
      const l = level(row.lights);
      if (l !== null && l !== state.lights) {
        batch.lightingEvents.push({ device: d.light, at: iso(at), level: l });
        state.lights = l;
      }
    }
    carry[label] = state;
  }

  // the ingestion path takes at most MAX_BATCH_ITEMS per batch
  const results: IngestResult[] = [];
  const all = (["readings", "doorCounts", "hvacEvents", "lightingEvents"] as const).flatMap((k) =>
    (batch[k] as unknown[]).map((item) => [k, item] as const),
  );
  for (let i = 0, part = 0; i < all.length; i += MAX_BATCH_ITEMS, part++) {
    const slice: IngestBatch = { readings: [], doorCounts: [], hvacEvents: [], lightingEvents: [] };
    for (const [k, item] of all.slice(i, i + MAX_BATCH_ITEMS)) (slice[k] as unknown[]).push(item);
    results.push(
      await ingestTelemetry(tx, ctx, { batch: slice, idempotencyKey: `import-${input.key}-${part}` }),
    );
  }
  return {
    rows: input.rows.length - skipped.unknownFloor - skipped.badTime,
    skipped: { ...skipped, unknownFloors: [...unknown].slice(0, 20) },
    counts: {
      readings: batch.readings.length,
      doorCounts: batch.doorCounts.length,
      hvacEvents: batch.hvacEvents.length,
      lightingEvents: batch.lightingEvents.length,
    },
    batches: results,
    carry,
  };
}
