/**
 * Exports a self-contained JSON snapshot of the simulated demo building, computed by the real pipeline, for static
 * prototypes and reviews that cannot run the stack (the no-code prototype is loaded from it).
 *
 * A throw-away database is created on the server behind TEST_DATABASE_URL (owner URL, as for the tests), seeded for
 * the window, read back as the runtime role and dropped. With ANTHROPIC_API_KEY set, the largest finding of each rule
 * in the last 14 days is explained by the worker's own code, once per locale.
 *
 *   TEST_DATABASE_URL=postgres://flowcarbon:flowcarbon-dev@localhost:5432/postgres \
 *     npm run snapshot -- --out snapshot.json [--start 2026-09-15 --days 28 --now "2026-10-12 19:30" --explain 1]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  addDays,
  DEFAULT_RULE_PARAMS,
  evaluateEpc,
  parseClock,
  RULE_PARAM_RATIONALE,
  RULES,
  SCHEDULE_LABELS,
  STRATEGIES,
  zonedTime,
} from "@flowcarbon/core";
import { createDb, schema, withOrg } from "@flowcarbon/db";
import { seedDemo } from "@flowcarbon/demo";
import { createTestDatabase } from "@flowcarbon/demo/testing";
import { buildingReport, loadBuildingContext, strategySummary } from "@flowcarbon/pipeline";
import { randomToken } from "@flowcarbon/security";
import { REFERENCES, runExplain } from "@flowcarbon/worker";
import { and, eq, isNull } from "drizzle-orm";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "snapshot.json" },
    start: { type: "string", default: "2026-09-15" },
    days: { type: "string", default: "28" },
    /** local building time used for the "floors now" view; defaults to 19:30 on the last day */
    now: { type: "string" },
    /** findings to explain per rule (0 = none) */
    explain: { type: "string", default: "1" },
    locales: { type: "string", default: "en,zh-CN" },
  },
});

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error("TEST_DATABASE_URL (an owner URL of the database server) is required");
  process.exit(1);
}
const start = args.start;
const days = Number(args.days);
const end = addDays(start, days);
const [nowDay, nowClock] = (args.now ?? `${addDays(end, -1)} 19:30`).split(" ");
const perRule = Number(args.explain);
const EPC_DEFAULTS = { escoShare: 0.6, years: 5, achieved: 1, discountRate: 0.06 };

const tdb = await createTestDatabase(adminUrl);
const owner = createDb(tdb.ownerUrl, { max: 2 });
const app = createDb(tdb.appUrl, { max: 4, statementTimeoutMs: 0 });
try {
  const t0 = Date.now();
  const seeded = await seedDemo(app.db, { startDate: start, days, password: randomToken(12) });
  console.log(
    `seeded ${start} + ${days} days in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${seeded.findings} findings`,
  );
  const { orgId, buildingId } = seeded;

  const { snapshot, picked } = await withOrg(app.db, orgId, async (tx) => {
    const ctx = await loadBuildingContext(tx, orgId, buildingId);
    const [building] = await tx.select().from(schema.buildings).where(eq(schema.buildings.id, buildingId));
    const floors = await tx.select().from(schema.floors).where(eq(schema.floors.buildingId, buildingId));
    const tenants = await tx.select().from(schema.tenants).where(eq(schema.tenants.buildingId, buildingId));
    const devices = await tx.select().from(schema.devices).where(eq(schema.devices.buildingId, buildingId));
    const daily = await tx
      .select()
      .from(schema.floorDaily)
      .where(eq(schema.floorDaily.buildingId, buildingId));
    const findings = await tx
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.buildingId, buildingId));
    const forecasts = await tx
      .select()
      .from(schema.forecasts)
      .where(eq(schema.forecasts.buildingId, buildingId));
    const overtime = await tx
      .select()
      .from(schema.overtimeRequests)
      .where(eq(schema.overtimeRequests.buildingId, buildingId));
    const instruments = await tx
      .select()
      .from(schema.contractualInstruments)
      .where(eq(schema.contractualInstruments.buildingId, buildingId));
    const factors = await tx
      .select()
      .from(schema.emissionFactors)
      .where(isNull(schema.emissionFactors.orgId));
    const strategies = await strategySummary(tx, ctx, start, end);
    const report = await buildingReport(tx, ctx, start, end);
    const nowAt = zonedTime(nowDay!, parseClock(nowClock!), ctx.building.timezone);
    const nowRows = await tx
      .select()
      .from(schema.floorIntervals)
      .where(
        and(
          eq(schema.floorIntervals.buildingId, buildingId),
          eq(schema.floorIntervals.startAt, new Date(nowAt)),
        ),
      );

    const label = new Map(floors.map((f) => [f.id, f.label]));
    const level = (floorId: string | null) =>
      floorId ? (floors.find((f) => f.id === floorId)?.level ?? 0) : 0;
    // stable output: the same window always exports byte-identical data apart from ids and timestamps
    const by =
      <T>(...keys: ((x: T) => string | number)[]) =>
      (a: T, b: T) => {
        for (const k of keys) {
          const x = k(a);
          const y = k(b);
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      };
    const tariff = ctx.building.tariff;
    const rate = tariff.kind === "flat" ? tariff.rate : undefined;
    // explained after this transaction: the largest findings of each rule in the last 14 days
    const since = new Date(zonedTime(addDays(end, -14), 0, ctx.building.timezone));
    const picked = Object.keys(RULES).flatMap((rule) =>
      findings
        .filter((f) => f.ruleId === rule && f.startAt >= since)
        .sort((a, b) => b.avoidableKwh - a.avoidableKwh)
        .slice(0, Math.max(0, perRule))
        .map((f) => f.id),
    );
    const snapshot = {
      generatedAt: new Date().toISOString(),
      simulated: true,
      window: { start, endExclusive: end, days },
      snapshotAt: new Date(nowAt).toISOString(),
      building: {
        name: building!.name,
        address: building!.address,
        timezone: building!.timezone,
        currency: building!.currency,
        workdayStart: building!.workdayStart,
        afterHoursStart: building!.afterHoursStart,
        gridRegion: building!.gridRegion,
        tariff: building!.tariff,
        bucketMinutes: building!.bucketMinutes,
        calendar: ctx.building.calendar,
      },
      ruleParams: Object.entries(DEFAULT_RULE_PARAMS).map(([name, value]) => ({
        name,
        value,
        rationale: RULE_PARAM_RATIONALE[name as keyof typeof RULE_PARAM_RATIONALE],
      })),
      rules: Object.values(RULES),
      strategyCatalog: Object.values(STRATEGIES).map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      references: Object.entries(REFERENCES).map(([id, r]) => ({ id, ...r })),
      scheduleLabels: SCHEDULE_LABELS,
      floors: floors
        .sort((a, b) => a.level - b.level)
        .map((f) => ({
          id: f.id,
          label: f.label,
          level: f.level,
          areaM2: f.areaM2,
          ratedHvacKw: f.ratedHvacKw,
          ratedLightingKw: f.ratedLightingKw,
          zoneOnlyFraction: f.zoneOnlyFraction,
          tenantId: ctx.floorTenant.get(f.id) ?? null,
          metered: devices.some((d) => d.floorId === f.id && d.kind === "meter"),
        })),
      tenants: tenants.sort(by((t) => t.name)).map((t) => ({
        id: t.id,
        name: t.name,
        overtimeRatePerHour: t.overtimeRatePerHour,
        contactEmail: t.contactEmail,
        floors: floors.filter((f) => ctx.floorTenant.get(f.id) === t.id).map((f) => f.label),
      })),
      devices: devices
        .sort(
          by(
            (d) => level(d.floorId),
            (d) => d.externalId,
          ),
        )
        .map((d) => ({
          floor: d.floorId ? label.get(d.floorId) : null,
          kind: d.kind,
          system: d.system,
          externalId: d.externalId,
          name: d.name,
        })),
      telemetry: seeded.telemetry,
      now: nowRows.sort(by((r) => level(r.floorId))).map((r) => ({
        floor: label.get(r.floorId),
        occupancy: r.occupancy,
        hvacMode: r.hvacMode,
        hvacOn: r.hvacOn,
        lightsOn: r.lightsOn,
        tier: r.tier,
      })),
      daily: daily
        .sort(
          by(
            (d) => d.day,
            (d) => level(d.floorId),
          ),
        )
        .map((d) => ({
          floor: label.get(d.floorId),
          day: d.day,
          dayType: d.dayType,
          kwhTotal: d.kwhTotal,
          kwhAfterHours: d.kwhAfterHours,
          kwhMeasured: d.kwhMeasured,
          cost: d.cost,
          afterHoursPeak: d.afterHoursPeak,
          afterHoursHvacHours: d.afterHoursHvacHours,
          avoidableKwh: d.avoidableKwh,
        })),
      findings: findings
        .sort(
          by(
            (f) => f.startAt.getTime(),
            (f) => level(f.floorId),
            (f) => f.ruleId,
          ),
        )
        .map((f) => ({
          id: f.id,
          floor: label.get(f.floorId),
          ruleId: f.ruleId,
          kind: f.kind,
          startAt: f.startAt.toISOString(),
          endAt: f.endAt.toISOString(),
          dayType: f.dayType,
          avoidableKwh: f.avoidableKwh,
          avoidableCost: f.avoidableCost,
          avoidableCo2eKg: f.avoidableCo2eKg,
          peakPeople: f.peakPeople,
          tier: f.tier,
          evidence: f.evidence,
          status: f.status,
        })),
      forecasts: forecasts
        .sort(
          by(
            (f) => f.day,
            (f) => level(f.floorId),
          ),
        )
        .map((f) => ({
          floor: label.get(f.floorId),
          day: f.day,
          dayType: f.dayType,
          median: f.median,
          low: f.low,
          high: f.high,
          basis: f.basis,
          advice: f.advice,
          method: f.method,
        })),
      overtime: overtime
        .sort(
          by(
            (o) => o.startAt.getTime(),
            (o) => level(o.floorId),
          ),
        )
        .map((o) => ({
          floor: label.get(o.floorId),
          tenantId: o.tenantId,
          startAt: o.startAt.toISOString(),
          hours: o.hours,
          expectedPeople: o.expectedPeople,
          status: o.status,
          recommendedMode: o.recommendedMode,
          approvedMode: o.approvedMode,
          fee: o.fee,
          recommendation: o.recommendation,
          createdAt: o.createdAt.toISOString(),
          decidedAt: o.decidedAt?.toISOString() ?? null,
        })),
      instruments: instruments.map((i) => ({
        kind: i.kind,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        kwh: i.kwh,
        kgPerKwh: i.kgPerKwh,
        description: i.description,
      })),
      factors: factors
        .sort(
          by(
            (f) => f.method,
            (f) => f.region,
            (f) => -f.year,
          ),
        )
        .map((f) => ({
          region: f.region,
          year: f.year,
          method: f.method,
          kgPerKwh: f.kgPerKwh,
          source: f.source,
          status: f.status,
        })),
      strategies: {
        ...strategies,
        epcDefaults: EPC_DEFAULTS,
        // EPC needs a single price; with a time-of-use tariff the consumer applies its own
        epc:
          rate === undefined
            ? []
            : strategies.strategies.map((s) => ({
                id: s.id,
                ...evaluateEpc({ annualKwh: s.annualKwh, tariff: rate, capex: s.capex, ...EPC_DEFAULTS }),
              })),
      },
      report,
      explanations: [] as Record<string, unknown>[],
    };
    return { snapshot, picked };
  });

  if (!process.env.ANTHROPIC_API_KEY || picked.length === 0) {
    console.log("no explanations (ANTHROPIC_API_KEY unset or --explain 0)");
  } else {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 2,
      timeout: 180_000,
      defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
        : undefined,
    });
    const model = process.env.AI_MODEL ?? "claude-opus-5-5";
    const effort = (process.env.AI_EFFORT ?? "medium") as "low" | "medium" | "high";
    // the worker writes in the requesting user's locale
    const [analyst] = await owner.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "analyst@flowcarbon-demo.example"));
    const out = [];
    for (const locale of args.locales.split(",")) {
      await owner.db.update(schema.users).set({ locale }).where(eq(schema.users.id, analyst!.id));
      const rows = await Promise.all(
        picked.map(async (findingId) => {
          const [row] = await withOrg(app.db, orgId, (tx) =>
            tx
              .insert(schema.aiExplanations)
              .values({ orgId, findingId, promptVersion: "explain-v1", input: {}, requestedBy: analyst!.id })
              .returning({ id: schema.aiExplanations.id }),
          );
          const outcome = await runExplain(
            { db: app.db, client, model, effort },
            { orgId, explanationId: row!.id },
          );
          const [e] = await withOrg(app.db, orgId, (tx) =>
            tx.select().from(schema.aiExplanations).where(eq(schema.aiExplanations.id, row!.id)),
          );
          console.log(
            `explanation ${locale} ${findingId.slice(0, 8)}: ${outcome}${e?.error ? ` (${e.error})` : ""}`,
          );
          return {
            findingId,
            locale,
            status: e!.status,
            model: e!.model,
            promptVersion: e!.promptVersion,
            output: e!.output,
            error: e!.error,
            inputTokens: e!.inputTokens,
            outputTokens: e!.outputTokens,
            completedAt: e!.completedAt?.toISOString() ?? null,
          };
        }),
      );
      out.push(...rows);
    }
    snapshot.explanations = out;
  }

  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 1)}\n`);
  const counts = Object.entries(snapshot)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${(v as unknown[]).length} ${k}`)
    .join(", ");
  console.log(`wrote ${args.out}: ${counts}`);
} finally {
  await app.close();
  await owner.close();
  await tdb.drop();
}
