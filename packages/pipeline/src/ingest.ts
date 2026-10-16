import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type BuildingContext, localDateOf } from "./context";

/** Upper bound of items in one ingestion request; gateways split larger backfills. */
export const MAX_BATCH_ITEMS = 50_000;
/** Accepted clock skew for timestamps in the future. */
export const MAX_FUTURE_SKEW_MS = 10 * 60_000;
/** Longest period a single energy reading may cover. */
export const MAX_READING_SPAN_MS = 24 * 3_600_000;

const timestamp = z.iso.datetime({ offset: true });
const device = z.string().min(1).max(128);

export const ingestBatchSchema = z
  .object({
    readings: z
      .array(z.object({ device, start: timestamp, end: timestamp, kwh: z.number().min(0).max(1_000_000) }))
      .default([]),
    doorCounts: z
      .array(
        z.object({
          device,
          start: timestamp,
          entries: z.number().int().min(0).max(100_000),
          exits: z.number().int().min(0).max(100_000),
        }),
      )
      .default([]),
    hvacEvents: z
      .array(z.object({ device, at: timestamp, mode: z.enum(["off", "setback", "full"]) }))
      .default([]),
    lightingEvents: z.array(z.object({ device, at: timestamp, level: z.number().min(0).max(1) })).default([]),
  })
  .refine(
    (b) => b.readings.length + b.doorCounts.length + b.hvacEvents.length + b.lightingEvents.length > 0,
    {
      message: "the batch is empty",
    },
  )
  .refine(
    (b) =>
      b.readings.length + b.doorCounts.length + b.hvacEvents.length + b.lightingEvents.length <=
      MAX_BATCH_ITEMS,
    { message: `a batch holds at most ${MAX_BATCH_ITEMS} items` },
  );

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export class IngestValidationError extends Error {
  readonly statusCode = 422;
  constructor(readonly problems: string[]) {
    super(
      `telemetry rejected: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`,
    );
  }
}

export interface IngestResult {
  batchId: string;
  duplicate: boolean;
  counts: Record<string, number>;
  /** local dates touched by the batch, [fromDate, toDateExclusive), for the recompute job */
  affected: { fromDate: string; toDateExclusive: string } | null;
}

const EXPECTED_KIND = {
  readings: "meter",
  doorCounts: "door_counter",
  hvacEvents: "bms_zone",
  lightingEvents: "lighting_controller",
} as const;

const CHUNK = 5_000;

/**
 * Validates and stores one batch of gateway telemetry for a building.
 *
 * - Devices are addressed by their external id and must belong to this building (the lookup runs under
 *   row-level security, so another organisation's devices are invisible) and be of the right kind.
 * - The batch is all-or-nothing: any problem rejects it with a list of reasons.
 * - Idempotent per (organisation, idempotency key): a retried request returns the original result and
 *   writes nothing. Re-sent samples with a new key overwrite earlier values (late corrections win).
 */
export async function ingestTelemetry(
  tx: Tx,
  ctx: BuildingContext,
  input: { batch: IngestBatch; idempotencyKey: string; apiKeyId?: string | null; now?: number },
): Promise<IngestResult> {
  const { batch } = input;
  const now = input.now ?? Date.now();
  const counts = {
    readings: batch.readings.length,
    doorCounts: batch.doorCounts.length,
    hvacEvents: batch.hvacEvents.length,
    lightingEvents: batch.lightingEvents.length,
  };

  // claim the idempotency key first; a concurrent request with the same key waits here, then sees a conflict
  const [claimed] = await tx
    .insert(schema.ingestionBatches)
    .values({
      orgId: ctx.orgId,
      buildingId: ctx.building.id,
      apiKeyId: input.apiKeyId ?? null,
      idempotencyKey: input.idempotencyKey,
      counts,
    })
    .onConflictDoNothing()
    .returning({ id: schema.ingestionBatches.id });
  if (!claimed) {
    const [prior] = await tx
      .select()
      .from(schema.ingestionBatches)
      .where(
        and(
          eq(schema.ingestionBatches.orgId, ctx.orgId),
          eq(schema.ingestionBatches.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!prior) throw new Error("idempotency key conflict without a visible batch");
    if (prior.buildingId !== ctx.building.id)
      throw new IngestValidationError(["idempotency key was already used for another building"]);
    return {
      batchId: prior.id,
      duplicate: true,
      counts: prior.counts,
      affected:
        prior.rangeFrom && prior.rangeTo
          ? {
              fromDate: localDateOf(ctx, prior.rangeFrom.getTime()),
              toDateExclusive: nextDate(localDateOf(ctx, prior.rangeTo.getTime() - 1)),
            }
          : null,
    };
  }

  const externalIds = new Set<string>();
  for (const r of batch.readings) externalIds.add(r.device);
  for (const r of batch.doorCounts) externalIds.add(r.device);
  for (const r of batch.hvacEvents) externalIds.add(r.device);
  for (const r of batch.lightingEvents) externalIds.add(r.device);
  const devices = await tx
    .select({
      id: schema.devices.id,
      externalId: schema.devices.externalId,
      kind: schema.devices.kind,
      floorId: schema.devices.floorId,
    })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.buildingId, ctx.building.id),
        inArray(schema.devices.externalId, [...externalIds]),
      ),
    );
  const byExternal = new Map(devices.map((d) => [d.externalId, d]));

  const problems: string[] = [];
  const unknown = [...externalIds].filter((e) => !byExternal.has(e));
  if (unknown.length)
    problems.push(
      `unknown devices for this building: ${unknown.slice(0, 20).join(", ")}${unknown.length > 20 ? " …" : ""}`,
    );
  for (const key of Object.keys(EXPECTED_KIND) as (keyof typeof EXPECTED_KIND)[]) {
    const wrong = new Set<string>();
    for (const item of batch[key]) {
      const d = byExternal.get(item.device);
      if (d && (d.kind !== EXPECTED_KIND[key] || !d.floorId)) wrong.add(item.device);
    }
    if (wrong.size)
      problems.push(
        `${key} must come from ${EXPECTED_KIND[key]} devices assigned to a floor: ${[...wrong].slice(0, 20).join(", ")}`,
      );
  }

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  const seen = (ts: number) => {
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  };
  let future = 0;
  let badSpan = 0;
  const readings = batch.readings.map((r) => {
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    if (!(end > start) || end - start > MAX_READING_SPAN_MS) badSpan++;
    if (end > now + MAX_FUTURE_SKEW_MS) future++;
    seen(start);
    seen(end - 1);
    return {
      orgId: ctx.orgId,
      deviceId: byExternal.get(r.device)?.id ?? "",
      startAt: new Date(start),
      endAt: new Date(end),
      kwh: r.kwh,
    };
  });
  const doorCounts = batch.doorCounts.map((r) => {
    const start = Date.parse(r.start);
    if (start > now + MAX_FUTURE_SKEW_MS) future++;
    seen(start);
    const d = byExternal.get(r.device);
    return {
      orgId: ctx.orgId,
      deviceId: d?.id ?? "",
      floorId: d?.floorId ?? "",
      startAt: new Date(start),
      entries: r.entries,
      exits: r.exits,
    };
  });
  const hvacEvents = batch.hvacEvents.map((r) => {
    const at = Date.parse(r.at);
    if (at > now + MAX_FUTURE_SKEW_MS) future++;
    seen(at);
    const d = byExternal.get(r.device);
    return {
      orgId: ctx.orgId,
      deviceId: d?.id ?? "",
      floorId: d?.floorId ?? "",
      at: new Date(at),
      mode: r.mode,
    };
  });
  const lightingEvents = batch.lightingEvents.map((r) => {
    const at = Date.parse(r.at);
    if (at > now + MAX_FUTURE_SKEW_MS) future++;
    seen(at);
    const d = byExternal.get(r.device);
    return {
      orgId: ctx.orgId,
      deviceId: d?.id ?? "",
      floorId: d?.floorId ?? "",
      at: new Date(at),
      level: r.level,
    };
  });
  if (badSpan) problems.push(`${badSpan} readings have an end not after their start or span more than 24 h`);
  if (future) problems.push(`${future} items are timestamped in the future`);
  const dupes: [string, number][] = [
    ["readings", countDuplicates(readings, (r) => `${r.deviceId}|${r.startAt.getTime()}`)],
    ["doorCounts", countDuplicates(doorCounts, (r) => `${r.deviceId}|${r.startAt.getTime()}`)],
    ["hvacEvents", countDuplicates(hvacEvents, (r) => `${r.deviceId}|${r.at.getTime()}`)],
    ["lightingEvents", countDuplicates(lightingEvents, (r) => `${r.deviceId}|${r.at.getTime()}`)],
  ];
  for (const [name, n] of dupes) if (n) problems.push(`${n} duplicate ${name} for the same device and time`);
  if (problems.length) throw new IngestValidationError(problems);

  for (let i = 0; i < readings.length; i += CHUNK)
    await tx
      .insert(schema.energyReadings)
      .values(readings.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [schema.energyReadings.deviceId, schema.energyReadings.startAt],
        set: { endAt: sql`excluded.end_at`, kwh: sql`excluded.kwh`, receivedAt: sql`now()` },
      });
  for (let i = 0; i < doorCounts.length; i += CHUNK)
    await tx
      .insert(schema.doorCounts)
      .values(doorCounts.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [schema.doorCounts.deviceId, schema.doorCounts.startAt],
        set: { entries: sql`excluded.entries`, exits: sql`excluded.exits`, receivedAt: sql`now()` },
      });
  for (let i = 0; i < hvacEvents.length; i += CHUNK)
    await tx
      .insert(schema.hvacEvents)
      .values(hvacEvents.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [schema.hvacEvents.deviceId, schema.hvacEvents.at],
        set: { mode: sql`excluded.mode`, receivedAt: sql`now()` },
      });
  for (let i = 0; i < lightingEvents.length; i += CHUNK)
    await tx
      .insert(schema.lightingEvents)
      .values(lightingEvents.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [schema.lightingEvents.deviceId, schema.lightingEvents.at],
        set: { level: sql`excluded.level`, receivedAt: sql`now()` },
      });

  await tx
    .update(schema.devices)
    .set({ lastSeenAt: new Date(now) })
    .where(
      inArray(
        schema.devices.id,
        devices.map((d) => d.id),
      ),
    );
  await tx
    .update(schema.ingestionBatches)
    .set({ rangeFrom: new Date(minTs), rangeTo: new Date(maxTs + 1) })
    .where(eq(schema.ingestionBatches.id, claimed.id));

  return {
    batchId: claimed.id,
    duplicate: false,
    counts,
    affected: { fromDate: localDateOf(ctx, minTs), toDateExclusive: nextDate(localDateOf(ctx, maxTs)) },
  };
}

function countDuplicates<T>(rows: readonly T[], key: (row: T) => string): number {
  const keys = new Set<string>();
  for (const r of rows) keys.add(key(r));
  return rows.length - keys.size;
}

function nextDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
