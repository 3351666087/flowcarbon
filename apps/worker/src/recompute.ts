import { addDays } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import { loadBuildingContext, localDateOf, processDays, refreshForecasts } from "@flowcarbon/pipeline";
import { and, eq, inArray, isNull } from "drizzle-orm";

/** Longest span processed in one transaction; longer backfills are split. */
export const CHUNK_DAYS = 14;

export interface Span {
  fromDate: string;
  toDateExclusive: string;
}

/** Merges overlapping or adjacent day spans. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.fromDate <= last.toDateExclusive) {
      if (s.toDateExclusive > last.toDateExclusive) last.toDateExclusive = s.toDateExclusive;
    } else out.push({ ...s });
  }
  return out;
}

export function chunkSpan(span: Span, days = CHUNK_DAYS): Span[] {
  const out: Span[] = [];
  for (let from = span.fromDate; from < span.toDateExclusive; ) {
    const next = addDays(from, days);
    const to = next < span.toDateExclusive ? next : span.toDateExclusive;
    out.push({ fromDate: from, toDateExclusive: to });
    from = to;
  }
  return out;
}

export interface RecomputeResult {
  batches: number;
  spans: Span[];
  days: number;
  findings: number;
}

/**
 * Processes every pending ingestion batch of a building: rebuilds intervals, roll-ups and findings for the
 * local days the batches touched (plus the following day, whose detection uses them as context), refreshes
 * the forecast, then marks the batches processed. Safe to retry: every step is idempotent.
 */
export async function runRecompute(
  db: Db,
  payload: { orgId: string; buildingId: string },
  now = Date.now(),
): Promise<RecomputeResult> {
  const { orgId, buildingId } = payload;
  const { pending, ctx } = await withOrg(db, orgId, async (tx) => ({
    ctx: await loadBuildingContext(tx, orgId, buildingId),
    pending: await tx
      .select({
        id: schema.ingestionBatches.id,
        rangeFrom: schema.ingestionBatches.rangeFrom,
        rangeTo: schema.ingestionBatches.rangeTo,
      })
      .from(schema.ingestionBatches)
      .where(
        and(
          eq(schema.ingestionBatches.buildingId, buildingId),
          eq(schema.ingestionBatches.status, "accepted"),
          isNull(schema.ingestionBatches.processedAt),
        ),
      ),
  }));
  if (!pending.length) return { batches: 0, spans: [], days: 0, findings: 0 };

  const today = localDateOf(ctx, now);
  const limit = addDays(today, 1);
  const spans = mergeSpans(
    pending
      .filter((b) => b.rangeFrom && b.rangeTo)
      .map((b) => {
        const fromDate = localDateOf(ctx, b.rangeFrom!.getTime());
        const through = addDays(localDateOf(ctx, b.rangeTo!.getTime() - 1), 2);
        return { fromDate, toDateExclusive: through < limit ? through : limit };
      })
      .filter((s) => s.fromDate < s.toDateExclusive),
  );

  let days = 0;
  let findings = 0;
  try {
    for (const span of spans)
      for (const chunk of chunkSpan(span)) {
        const r = await withOrg(db, orgId, async (tx) =>
          processDays(
            tx,
            await loadBuildingContext(tx, orgId, buildingId),
            chunk.fromDate,
            chunk.toDateExclusive,
          ),
        );
        days += r.days;
        findings += r.upserted;
      }
    await withOrg(db, orgId, async (tx) => {
      await refreshForecasts(tx, await loadBuildingContext(tx, orgId, buildingId), today, 7);
      await tx
        .update(schema.ingestionBatches)
        .set({ status: "processed", processedAt: new Date(), error: null })
        .where(
          inArray(
            schema.ingestionBatches.id,
            pending.map((b) => b.id),
          ),
        );
    });
  } catch (err) {
    // keep the batches pending so the retry picks them up, but record why this attempt failed
    const message = err instanceof Error ? err.message.slice(0, 1000) : String(err);
    await withOrg(db, orgId, (tx) =>
      tx
        .update(schema.ingestionBatches)
        .set({ error: message })
        .where(
          inArray(
            schema.ingestionBatches.id,
            pending.map((b) => b.id),
          ),
        ),
    );
    throw err;
  }
  return { batches: pending.length, spans, days, findings };
}

/** Called once the queue gives up: the batches are marked failed so data health shows them. */
export async function markRecomputeFailed(db: Db, payload: { orgId: string; buildingId: string }) {
  await withOrg(db, payload.orgId, (tx) =>
    tx
      .update(schema.ingestionBatches)
      .set({ status: "failed" })
      .where(
        and(
          eq(schema.ingestionBatches.buildingId, payload.buildingId),
          eq(schema.ingestionBatches.status, "accepted"),
          isNull(schema.ingestionBatches.processedAt),
        ),
      ),
  );
}
