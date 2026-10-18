import { addDays, type HvacMode, localParts, triageOvertime } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import {
  type IngestBatch,
  ingestTelemetry,
  loadBuildingContext,
  processDays,
  refreshForecasts,
} from "@flowcarbon/pipeline";
import { sampleTower, simulate } from "@flowcarbon/sim";
import { and, eq, like, max } from "drizzle-orm";
import { dedupeLast, deviceIds } from "./seed";

export interface PumpOptions {
  /** organisation created by seedDemo */
  slug?: string;
  /** wall-clock time to simulate up to (default: now) */
  now?: number;
  /** base seed; each simulated day derives its own */
  seed?: number;
  /** never reach back further than this many days (a pump that was down longer leaves a gap) */
  maxCatchUpDays?: number;
  log?: (msg: string) => void;
}

export interface PumpResult {
  days: string[];
  telemetry: Record<string, number>;
  overtimeRequests: number;
  findings: number;
}

const DAY_MS = 86_400_000;

/**
 * Keeps the simulated demo building live. Simulates every day from the last one with data up to `now`, writes the
 * elapsed part through the same ingestion function the telemetry API uses, records the simulated tenants'
 * overtime requests as approved (as the seed does), and recomputes intervals, findings and forecasts.
 *
 * Idempotent: telemetry is upserted per device and timestamp, requests are matched on floor and start time, so
 * running it twice for the same `now` changes nothing.
 */
export async function pumpDemo(db: Db, opts: PumpOptions = {}): Promise<PumpResult> {
  const slug = opts.slug ?? "tower-a-demo";
  const now = opts.now ?? Date.now();
  const log = opts.log ?? (() => {});
  const sb = sampleTower();
  const tz = sb.building.timezone;

  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
  if (!org) throw new Error(`organisation ${slug} does not exist; run the seed first`);

  return withOrg(db, org.id, async (tx) => {
    const [building] = await tx.select().from(schema.buildings).where(eq(schema.buildings.orgId, org.id));
    if (!building) throw new Error(`organisation ${slug} has no building`);
    const ctx = await loadBuildingContext(tx, org.id, building.id);

    const today = localParts(now, tz).dateKey;
    const [last] = await tx
      .select({ at: max(schema.doorCounts.startAt) })
      .from(schema.doorCounts)
      .where(eq(schema.doorCounts.orgId, org.id));
    // a day is continued only if its last bucket is missing; complete days (the seed's) are never re-simulated
    const bucketMs = ctx.bucketMinutes * 60_000;
    let first = addDays(today, -1);
    if (last?.at) {
      const lastDay = localParts(last.at.getTime(), tz).dateKey;
      const complete = localParts(last.at.getTime() + bucketMs, tz).dateKey !== lastDay;
      first = complete ? addDays(lastDay, 1) : lastDay;
    }
    const earliest = addDays(today, -(opts.maxCatchUpDays ?? 7));
    if (first < earliest) first = earliest;
    const days: string[] = [];
    for (let d = first; d <= today; d = addDays(d, 1)) days.push(d);
    if (!days.length) return { days, telemetry: {}, overtimeRequests: 0, findings: 0 };

    const floorId = new Map(
      (await tx.select().from(schema.floors).where(eq(schema.floors.buildingId, building.id))).map((f) => [
        f.label,
        f.id,
      ]),
    );
    const tenantId = new Map(
      (await tx.select().from(schema.tenants).where(eq(schema.tenants.buildingId, building.id))).map((t) => [
        t.name,
        t.id,
      ]),
    );
    const label = new Map(sb.floors.map((f) => [f.id, f.label]));
    const tenantProfile = new Map(sb.tenants.map((t) => [t.id, t]));
    const telemetry: Record<string, number> = {
      readings: 0,
      doorCounts: 0,
      hvacEvents: 0,
      lightingEvents: 0,
    };
    let overtimeRequests = 0;
    const iso = (ts: number) => new Date(ts).toISOString();
    const runKey = Math.floor(now / 60_000);

    for (const day of days) {
      const dayIndex = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
      const sim = simulate(sb, { startDate: day, days: 1, seed: (opts.seed ?? 20261013) + dayIndex });
      const until = Math.min(now, sim.to);
      // only complete readings and buckets, so a later run never overwrites a partial value with a different one
      const batch: IngestBatch = {
        readings: sim.readings
          .filter((r) => r.end <= until)
          .map((r) => ({
            device: deviceIds(label.get(r.floorId)!).meter(r.system),
            start: iso(r.start),
            end: iso(r.end),
            kwh: r.kwh,
          })),
        doorCounts: sim.doorCounts
          .filter((d) => d.start + bucketMs <= until)
          .map((d) => ({
            device: deviceIds(label.get(d.floorId)!).door,
            start: iso(d.start),
            entries: d.entries,
            exits: d.exits,
          })),
        hvacEvents: dedupeLast(
          sim.hvacEvents
            .filter((e) => e.ts <= until && e.ts < sim.to)
            .map((e) => ({
              device: deviceIds(label.get(e.floorId)!).bms,
              at: iso(e.ts),
              mode: e.mode as HvacMode,
            })),
        ),
        lightingEvents: dedupeLast(
          sim.lightingEvents
            .filter((e) => e.ts <= until && e.ts < sim.to)
            .map((e) => ({ device: deviceIds(label.get(e.floorId)!).light, at: iso(e.ts), level: e.level })),
        ),
      };
      for (const key of Object.keys(telemetry) as (keyof IngestBatch)[])
        telemetry[key] = (telemetry[key] ?? 0) + batch[key].length;
      if (
        batch.readings.length +
        batch.doorCounts.length +
        batch.hvacEvents.length +
        batch.lightingEvents.length
      )
        await ingestTelemetry(tx, ctx, { batch, idempotencyKey: `pump-${slug}-${day}-${runKey}`, now });

      for (const o of sim.overtime) {
        if (o.requestedAt > now) continue;
        const floor = sb.floors.find((f) => f.id === o.floorId)!;
        const fid = floorId.get(floor.label)!;
        const [exists] = await tx
          .select({ id: schema.overtimeRequests.id })
          .from(schema.overtimeRequests)
          .where(
            and(
              eq(schema.overtimeRequests.floorId, fid),
              eq(schema.overtimeRequests.startAt, new Date(o.start)),
            ),
          );
        if (exists) continue;
        const tenant = tenantProfile.get(o.tenantId)!;
        const triage = triageOvertime(o, tenant, floor);
        await tx.insert(schema.overtimeRequests).values({
          orgId: org.id,
          buildingId: building.id,
          tenantId: tenantId.get(tenant.name)!,
          floorId: fid,
          startAt: new Date(o.start),
          hours: o.hours,
          expectedPeople: o.expectedPeople,
          status: "approved",
          recommendedMode: triage.mode,
          approvedMode: triage.mode,
          fee: triage.fee,
          recommendation: triage.note,
          decidedAt: new Date(Math.min(o.requestedAt + 3_600_000, now)),
          createdAt: new Date(o.requestedAt),
        });
        overtimeRequests++;
      }
    }

    const processed = await processDays(tx, ctx, days[0]!, addDays(today, 1), now);
    await refreshForecasts(tx, ctx, today, 7);
    // processed synchronously above, like the seed
    await tx
      .update(schema.ingestionBatches)
      .set({ status: "processed", processedAt: new Date(now) })
      .where(
        and(
          eq(schema.ingestionBatches.buildingId, building.id),
          eq(schema.ingestionBatches.status, "accepted"),
          like(schema.ingestionBatches.idempotencyKey, `pump-${slug}-%`),
        ),
      );
    log(
      `${days[0]} → ${today}: ${Object.entries(telemetry)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}, ${overtimeRequests} requests, ${processed.upserted} findings`,
    );
    return { days, telemetry, overtimeRequests, findings: processed.upserted };
  });
}
