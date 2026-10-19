/**
 * Loads a case dataset (a table in the import format, see the Data page) into an organisation of its own, for
 * operators: creates the organisation, building and floors if they are missing, adds members by email, imports the
 * table through the same path as the web import and processes every day it covers at once.
 *
 * usage: node case.mjs --slug lbnl-b59-case --org "LBNL Building 59 (case data)" --building "Building 59 south wing"
 *   --address "Berkeley, California" --timezone America/Los_Angeles --currency USD --grid US-CAMX --tariff 0.2
 *   --floor "3-4S:2600:60:6" --member owner:someone@example.com --csv /case/lbnl-b59-south.csv
 * (--floor is label:area m²:rated HVAC kW:rated lighting kW, repeatable; --member is role:email, repeatable)
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { localParts } from "@flowcarbon/core";
import { createDb, schema, withOrg } from "@flowcarbon/db";
import {
  type ImportCarry,
  type ImportRow,
  importRows,
  loadBuildingContext,
  MAX_IMPORT_ROWS,
  processDays,
  refreshForecasts,
} from "@flowcarbon/pipeline";
import { and, eq, like, sql } from "drizzle-orm";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    org: { type: "string" },
    building: { type: "string" },
    address: { type: "string" },
    timezone: { type: "string", default: "Asia/Shanghai" },
    currency: { type: "string", default: "CNY" },
    grid: { type: "string", default: "CN-East" },
    tariff: { type: "string", default: "0.85" },
    floor: { type: "string", multiple: true, default: [] },
    member: { type: "string", multiple: true, default: [] },
    csv: { type: "string" },
  },
});
if (!values.slug || !values.org || !values.building || !values.csv) {
  console.error("--slug, --org, --building and --csv are required");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

/** the import table: a header line, then plain comma-separated values (no quoting needed for these columns) */
function readTable(path: string): ImportRow[] {
  const [header, ...lines] = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cols = header!.split(",").map((c) => c.trim().toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v));
  return lines.map((line) => {
    const v = line.split(",");
    const hvac = at("hvac") >= 0 ? v[at("hvac")]?.trim() : undefined;
    return {
      time: v[at("time")]!.trim(),
      floor: v[at("floor")]!.trim(),
      people: at("people") >= 0 ? num(v[at("people")]) : undefined,
      hvacKwh: at("hvac_kwh") >= 0 ? num(v[at("hvac_kwh")]) : undefined,
      lightingKwh: at("lighting_kwh") >= 0 ? num(v[at("lighting_kwh")]) : undefined,
      plugKwh: at("plug_kwh") >= 0 ? num(v[at("plug_kwh")]) : undefined,
      hvac: hvac === undefined || hvac === "" ? undefined : (hvac as "off" | "setback" | "full"),
      lights: at("lights") >= 0 ? num(v[at("lights")]) : undefined,
    };
  });
}

const { db, close } = createDb(url, { max: 2, statementTimeoutMs: 0, applicationName: "flowcarbon-case" });
try {
  const started = Date.now();
  let [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, values.slug));
  if (!org) {
    [org] = await db.insert(schema.organizations).values({ slug: values.slug, name: values.org }).returning();
    console.log(`created organisation ${values.slug}`);
  }
  const orgId = org!.id;

  for (const m of values.member) {
    const [role, email] = m.split(":") as [string, string];
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`);
    if (!user) {
      console.log(`no account for ${email}; skipped`);
      continue;
    }
    await db
      .insert(schema.memberships)
      .values({ orgId, userId: user.id, role: role as "owner" })
      .onConflictDoNothing();
    console.log(`member ${email} (${role})`);
  }

  const buildingId = await withOrg(db, orgId, async (tx) => {
    let [b] = await tx.select().from(schema.buildings).where(eq(schema.buildings.name, values.building!));
    if (!b)
      [b] = await tx
        .insert(schema.buildings)
        .values({
          orgId,
          name: values.building!,
          address: values.address ?? null,
          timezone: values.timezone!,
          currency: values.currency!,
          gridRegion: values.grid!,
          tariff: { kind: "flat", rate: Number(values.tariff) },
        })
        .returning();
    const have = new Set(
      (
        await tx
          .select({ label: schema.floors.label })
          .from(schema.floors)
          .where(eq(schema.floors.buildingId, b!.id))
      ).map((f) => f.label),
    );
    let level = have.size;
    for (const spec of values.floor) {
      const [label, area, hvac, light] = spec.split(":");
      if (!label || have.has(label)) continue;
      await tx.insert(schema.floors).values({
        orgId,
        buildingId: b!.id,
        label,
        level: ++level,
        areaM2: Number(area),
        ratedHvacKw: Number(hvac),
        ratedLightingKw: Number(light),
      });
    }
    return b!.id;
  });

  const rows = readTable(values.csv);
  let carry: ImportCarry = {};
  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += MAX_IMPORT_ROWS) {
    const r = await withOrg(db, orgId, async (tx) =>
      importRows(tx, await loadBuildingContext(tx, orgId, buildingId), {
        rows: rows.slice(i, i + MAX_IMPORT_ROWS),
        carry,
        key: `case-${values.slug}-${i / MAX_IMPORT_ROWS}`,
      }),
    );
    carry = r.carry;
    imported += r.rows;
    skipped += r.skipped.unknownFloor + r.skipped.badTime;
    console.log(`imported ${imported} rows`);
  }

  // process every day the table covers, then mark its batches processed (as the seed does)
  const processed = await withOrg(db, orgId, async (tx) => {
    const ctx = await loadBuildingContext(tx, orgId, buildingId);
    const [range] = await tx
      .select({
        from: sql<Date>`min(${schema.ingestionBatches.rangeFrom})`,
        to: sql<Date>`max(${schema.ingestionBatches.rangeTo})`,
      })
      .from(schema.ingestionBatches)
      .where(
        and(
          eq(schema.ingestionBatches.buildingId, buildingId),
          like(schema.ingestionBatches.idempotencyKey, `import-case-${values.slug}-%`),
        ),
      );
    if (!range?.from || !range.to) return null;
    const fromDate = localParts(new Date(range.from).getTime(), ctx.building.timezone).dateKey;
    const last = localParts(new Date(range.to).getTime(), ctx.building.timezone).dateKey;
    const toDateExclusive = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const p = await processDays(tx, ctx, fromDate, toDateExclusive);
    await refreshForecasts(tx, ctx, toDateExclusive, 7);
    await tx
      .update(schema.ingestionBatches)
      .set({ status: "processed", processedAt: new Date() })
      .where(
        and(
          eq(schema.ingestionBatches.buildingId, buildingId),
          like(schema.ingestionBatches.idempotencyKey, `import-case-${values.slug}-%`),
        ),
      );
    return { fromDate, toDateExclusive, ...p };
  });
  console.log(
    `${values.slug}: ${imported} rows imported (${skipped} skipped)` +
      (processed
        ? `, ${processed.fromDate} to ${processed.toDateExclusive}: ${processed.days} days, ${processed.intervals} intervals, ${processed.upserted} findings`
        : "") +
      ` in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
} finally {
  await close();
}
