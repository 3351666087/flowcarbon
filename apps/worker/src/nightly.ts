import { addDays, localParts, zonedTime } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import type { JobQueue } from "@flowcarbon/jobs";
import { isNull, lt } from "drizzle-orm";

export interface NightlyResult {
  buildings: number;
  scheduled: number;
}

/**
 * Runs every hour. Buildings whose local time is in the nightly hour get yesterday reprocessed with complete
 * context (late data, approvals made after the fact) and their forecasts refreshed by the recompute job.
 * Housekeeping (expired sessions and invitations) runs on every tick.
 */
export async function runNightly(
  db: Db,
  jobs: JobQueue,
  opts: { localHour: number; now?: number },
): Promise<NightlyResult> {
  const now = opts.now ?? Date.now();
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date(now)));
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
  let buildings = 0;
  let scheduled = 0;
  for (const org of orgs) {
    const due = await withOrg(db, org.id, async (tx) => {
      await tx
        .delete(schema.invitations)
        .where(lt(schema.invitations.expiresAt, new Date(now - 30 * 86_400_000)));
      const list = await tx.select().from(schema.buildings).where(isNull(schema.buildings.archivedAt));
      buildings += list.length;
      const out: string[] = [];
      for (const b of list) {
        const local = localParts(now, b.timezone);
        if (Math.floor(local.minuteOfDay / 60) !== opts.localHour) continue;
        const yesterday = addDays(local.dateKey, -1);
        await tx
          .insert(schema.ingestionBatches)
          .values({
            orgId: org.id,
            buildingId: b.id,
            idempotencyKey: `nightly-${b.id}-${yesterday}`,
            counts: {},
            rangeFrom: new Date(zonedTime(yesterday, 0, b.timezone)),
            rangeTo: new Date(zonedTime(local.dateKey, 0, b.timezone)),
          })
          .onConflictDoNothing();
        out.push(b.id);
      }
      return out;
    });
    for (const buildingId of due) {
      await jobs.recompute({ orgId: org.id, buildingId });
      scheduled++;
    }
  }
  return { buildings, scheduled };
}
