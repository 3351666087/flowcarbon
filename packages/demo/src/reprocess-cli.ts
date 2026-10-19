/**
 * Reprocesses an organisation's buildings over a range of local days, for operators: rebuilds intervals, roll-ups
 * and findings from the stored telemetry (for example after a fix to the processing), then refreshes forecasts.
 * Days are processed in parts of two weeks, each in its own transaction.
 *
 * usage: node reprocess.mjs --slug lbnl-b59-case --from 2019-02-21 --to 2019-02-23
 * (--to is exclusive; it defaults to tomorrow in each building's time zone)
 */
import { parseArgs } from "node:util";
import { addDays, localParts } from "@flowcarbon/core";
import { createDb, schema, withOrg } from "@flowcarbon/db";
import { loadBuildingContext, processDays, refreshForecasts } from "@flowcarbon/pipeline";
import { and, eq, isNull } from "drizzle-orm";

const PART_DAYS = 14;

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  },
});
if (!values.slug || !values.from || !/^\d{4}-\d{2}-\d{2}$/.test(values.from)) {
  console.error("--slug and --from (YYYY-MM-DD) are required");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = createDb(url, {
  max: 2,
  statementTimeoutMs: 0,
  applicationName: "flowcarbon-reprocess",
});
try {
  const started = Date.now();
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, values.slug));
  if (!org) throw new Error(`no organisation ${values.slug}`);
  const buildings = await withOrg(db, org.id, (tx) =>
    // filtered by organisation as well as by row-level security, which an owner connection bypasses
    tx
      .select()
      .from(schema.buildings)
      .where(and(eq(schema.buildings.orgId, org.id), isNull(schema.buildings.archivedAt))),
  );
  for (const b of buildings) {
    const to = values.to ?? addDays(localParts(Date.now(), b.timezone).dateKey, 1);
    let intervals = 0;
    let findings = 0;
    let removed = 0;
    for (let from = values.from; from < to; from = addDays(from, PART_DAYS)) {
      const until = addDays(from, PART_DAYS) < to ? addDays(from, PART_DAYS) : to;
      const r = await withOrg(db, org.id, async (tx) =>
        processDays(tx, await loadBuildingContext(tx, org.id, b.id), from, until),
      );
      intervals += r.intervals;
      findings += r.upserted;
      removed += r.removed;
    }
    await withOrg(db, org.id, async (tx) =>
      refreshForecasts(tx, await loadBuildingContext(tx, org.id, b.id), to, 7),
    );
    console.log(
      `${values.slug} / ${b.name}: ${values.from} to ${to}: ${intervals} intervals, ${findings} findings, ${removed} removed`,
    );
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await close();
}
