import {
  averageRate,
  DEFAULT_RULE_PARAMS,
  evaluateEpc,
  RULE_PARAM_RATIONALE,
  RULES,
  SCHEDULE_LABELS,
  STRATEGIES,
  zonedTime,
} from "@flowcarbon/core";
import { schema } from "@flowcarbon/db";
import { buildingReport, floorsNow, latestDataDay, strategySummary } from "@flowcarbon/pipeline";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { visibleFloorIds } from "../auth/access";
import { badRequest, notFound, unprocessable } from "../errors";
import { buildingParams, dateKey, decodeCursor, encodeCursor, errorResponses, iso, uuid } from "../schemas";
import { addDaysKey, dateRange, inBuilding, todayIn, withBuildingContext } from "./helpers";

const dayType = z.enum(["workday", "weekend", "holiday"]);
const factorOut = z.object({
  id: z.string(),
  region: z.string(),
  year: z.number(),
  method: z.enum(["location", "market"]),
  kgPerKwh: z.number(),
  source: z.string(),
  status: z.enum(["verified", "to_verify"]),
});
const reportOut = z.object({
  period: z.object({
    from: z.string(),
    to: z.string(),
    days: z.number(),
    dayTypes: z.record(dayType, z.number()),
  }),
  totals: z.object({
    kwh: z.number(),
    afterHoursKwh: z.number(),
    cost: z.number(),
    avoidableKwh: z.number(),
    avoidableCost: z.number(),
    avoidableShare: z.number(),
    measuredShare: z.number(),
  }),
  scope2: z.object({
    kwh: z.number(),
    locationBasedKg: z.number(),
    marketBasedKg: z.number(),
    greenShare: z.number(),
    locationFactor: factorOut,
    residualFactor: factorOut.nullable(),
  }),
  avoidableCo2eKg: z.number(),
  byFloor: z.array(
    z.object({
      floorId: z.string(),
      label: z.string(),
      kwh: z.number(),
      afterHoursKwh: z.number(),
      avoidableKwh: z.number(),
    }),
  ),
  byDayType: z.array(z.object({ dayType, days: z.number(), kwh: z.number(), avoidableKwh: z.number() })),
  byRule: z.array(
    z.object({
      ruleId: z.string(),
      name: z.string(),
      kind: z.enum(["waste", "opportunity"]),
      count: z.number(),
      kwh: z.number(),
    }),
  ),
  disclosures: z.array(z.string()),
});
const findingOut = z.object({
  id: uuid,
  floorId: uuid,
  ruleId: z.string(),
  ruleName: z.string(),
  kind: z.enum(["waste", "opportunity"]),
  startAt: z.string(),
  endAt: z.string(),
  dayType,
  avoidableKwh: z.number(),
  avoidableCost: z.number(),
  avoidableCo2eKg: z.number(),
  peakPeople: z.number(),
  tier: z.enum(["measured", "estimated"]),
  evidence: z.object({ summary: z.string(), facts: z.record(z.string(), z.union([z.string(), z.number()])) }),
  params: z.record(z.string(), z.unknown()),
  status: z.enum(["open", "acknowledged", "fixed", "dismissed"]),
  statusNote: z.string().nullable(),
  statusAt: z.string().nullable(),
});
const explanationOut = z.object({
  id: uuid,
  status: z.enum(["pending", "done", "failed"]),
  model: z.string().nullable(),
  promptVersion: z.string(),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
const epcInputs = z.object({
  strategyId: z.enum(["occupancy_gated_workday", "zone_only_non_working", "auto_lights_off", "full_package"]),
  annualKwh: z.number().min(0).max(1e10).optional(),
  tariff: z.number().min(0).max(100).optional(),
  achieved: z.number().min(0).max(2).default(1),
  capex: z.number().min(0).max(1e10).optional(),
  escoShare: z.number().min(0).max(1).default(0.6),
  years: z.number().int().min(1).max(30).default(5),
  discountRate: z.number().min(0).max(0.5).default(0.06),
  annualOpex: z.number().min(0).max(1e9).default(0),
});
const epcOut = z.object({
  inputs: z.record(z.string(), z.union([z.number(), z.string()])),
  annualSaving: z.number(),
  ownerAnnual: z.number(),
  escoAnnual: z.number(),
  escoPaybackYears: z.number().nullable(),
  selfFundedPaybackYears: z.number().nullable(),
  escoNpv: z.number(),
  ownerNpv: z.number(),
  contractValue: z.number(),
  timeline: z.array(
    z.object({
      year: z.number(),
      saving: z.number(),
      ownerCumulative: z.number(),
      escoCumulative: z.number(),
    }),
  ),
});

type FindingRow = typeof schema.findings.$inferSelect;
const findingJson = (f: FindingRow) => ({
  id: f.id,
  floorId: f.floorId,
  ruleId: f.ruleId,
  ruleName: RULES[f.ruleId as keyof typeof RULES]?.name ?? f.ruleId,
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
  params: f.params,
  status: f.status,
  statusNote: f.statusNote,
  statusAt: iso(f.statusAt),
});
const finite = (n: number) => (Number.isFinite(n) ? n : null);

export const analyticsRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs }) => {
  app.get(
    "/rules",
    {
      schema: {
        tags: ["analytics"],
        summary: "Rule catalogue, default thresholds and their rationale",
        response: {
          200: z.object({
            rules: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                name: z.string(),
                physics: z.string(),
                quantification: z.string(),
              }),
            ),
            params: z.array(
              z.object({
                name: z.string(),
                default: z.union([z.number(), z.string()]),
                rationale: z.string(),
              }),
            ),
            strategies: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
          }),
        },
      },
    },
    async () => ({
      rules: Object.values(RULES),
      params: Object.entries(DEFAULT_RULE_PARAMS).map(([name, v]) => ({
        name,
        default: v,
        rationale: RULE_PARAM_RATIONALE[name as keyof typeof RULE_PARAM_RATIONALE],
      })),
      strategies: Object.values(STRATEGIES).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
    }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/overview",
    {
      schema: {
        tags: ["analytics"],
        summary: "Current state per floor and the last 28 days at a glance",
        params: buildingParams,
        response: {
          200: z.object({
            asOf: z.string().nullable(),
            floors: z.array(
              z.object({
                floorId: uuid,
                label: z.string(),
                level: z.number(),
                tenantId: z.string().nullable(),
                at: z.string().nullable(),
                occupancy: z.number(),
                hvacMode: z.string(),
                lightsOn: z.number(),
                wasteNow: z.boolean(),
                avoidableKwh28d: z.number(),
                openFindings: z.number(),
              }),
            ),
            last28: reportOut.shape.totals
              .extend({ co2eKg: z.number(), greenShare: z.number(), from: z.string(), to: z.string() })
              .nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "usage:read", async (tx, access, ctx) => {
        const last = await latestDataDay(tx, ctx);
        const today = last ?? todayIn(ctx.building.timezone);
        const visible = await visibleFloorIds(tx, access, ctx.building.id, todayIn(ctx.building.timezone));
        const floors = (await floorsNow(tx, ctx, today)).filter((f) => !visible || visible.has(f.floorId));
        let last28 = null;
        // building-wide figures are for staff only; tenant admins see their floors
        if (!access.tenantId && last) {
          const from = addDaysKey(last, -27);
          const to = addDaysKey(last, 1);
          const r = await buildingReport(tx, ctx, from, to);
          last28 = {
            ...r.totals,
            co2eKg: r.scope2.locationBasedKg,
            greenShare: r.scope2.greenShare,
            from,
            to,
          };
        }
        return {
          asOf: last,
          floors: floors.map((f) => ({ ...f, at: f.at ? new Date(f.at).toISOString() : null })),
          last28,
        };
      }),
  );

  // ---- findings ------------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/findings",
    {
      schema: {
        tags: ["analytics"],
        summary: "Findings, newest first, with keyset pagination",
        params: buildingParams,
        querystring: z.object({
          status: z.enum(["open", "acknowledged", "fixed", "dismissed"]).optional(),
          floorId: uuid.optional(),
          ruleId: z.string().max(64).optional(),
          from: dateKey.optional(),
          to: dateKey.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(findingOut), nextCursor: z.string().nullable() }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:read", async (tx, _a, ctx) => {
        const q = req.query;
        const tz = ctx.building.timezone;
        const cursor = decodeCursor(q.cursor);
        const conditions = [
          eq(schema.findings.buildingId, ctx.building.id),
          q.status ? eq(schema.findings.status, q.status) : undefined,
          q.floorId ? eq(schema.findings.floorId, q.floorId) : undefined,
          q.ruleId ? eq(schema.findings.ruleId, q.ruleId) : undefined,
          q.from ? gte(schema.findings.startAt, new Date(zonedTime(q.from, 0, tz))) : undefined,
          q.to ? lt(schema.findings.startAt, new Date(zonedTime(q.to, 0, tz))) : undefined,
          cursor && typeof cursor[0] === "string" && typeof cursor[1] === "string"
            ? or(
                lt(schema.findings.startAt, new Date(cursor[0])),
                and(eq(schema.findings.startAt, new Date(cursor[0])), lt(schema.findings.id, cursor[1])),
              )
            : undefined,
        ];
        const rows = await tx
          .select()
          .from(schema.findings)
          .where(and(...conditions))
          .orderBy(desc(schema.findings.startAt), desc(schema.findings.id))
          .limit(q.limit + 1);
        const page = rows.slice(0, q.limit);
        const lastRow = page[page.length - 1];
        return {
          items: page.map(findingJson),
          nextCursor:
            rows.length > q.limit && lastRow
              ? encodeCursor([lastRow.startAt.toISOString(), lastRow.id])
              : null,
        };
      }),
  );

  const findingParams = buildingParams.extend({ findingId: uuid });

  app.get(
    "/orgs/:orgId/buildings/:buildingId/findings/:findingId",
    {
      schema: {
        tags: ["analytics"],
        summary: "One finding with its AI explanations",
        params: findingParams,
        response: { 200: findingOut.extend({ explanations: z.array(explanationOut) }), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, _a, b) => {
        const [f] = await tx
          .select()
          .from(schema.findings)
          .where(and(eq(schema.findings.id, req.params.findingId), eq(schema.findings.buildingId, b.id)));
        if (!f) throw notFound("Finding");
        const ex = await tx
          .select()
          .from(schema.aiExplanations)
          .where(eq(schema.aiExplanations.findingId, f.id))
          .orderBy(desc(schema.aiExplanations.createdAt))
          .limit(10);
        return {
          ...findingJson(f),
          explanations: ex.map((e) => ({
            id: e.id,
            status: e.status,
            model: e.model,
            promptVersion: e.promptVersion,
            output: e.output,
            error: e.error,
            createdAt: e.createdAt.toISOString(),
            completedAt: iso(e.completedAt),
          })),
        };
      }),
  );

  app.patch(
    "/orgs/:orgId/buildings/:buildingId/findings/:findingId",
    {
      schema: {
        tags: ["analytics"],
        summary: "Review a finding: acknowledge, mark fixed or dismiss (with a reason)",
        params: findingParams,
        body: z.object({
          status: z.enum(["open", "acknowledged", "fixed", "dismissed"]),
          note: z.string().trim().max(1000).optional(),
        }),
        response: { 200: findingOut, ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:review", async (tx, access, b) => {
        if (req.body.status === "dismissed" && !req.body.note)
          throw unprocessable("Say why the finding is dismissed.");
        const [before] = await tx
          .select()
          .from(schema.findings)
          .where(and(eq(schema.findings.id, req.params.findingId), eq(schema.findings.buildingId, b.id)));
        if (!before) throw notFound("Finding");
        const [f] = await tx
          .update(schema.findings)
          .set({
            status: req.body.status,
            statusNote: req.body.note ?? null,
            statusBy: access.actor.type === "user" ? access.actor.id : null,
            statusAt: new Date(),
          })
          .where(eq(schema.findings.id, before.id))
          .returning();
        await audit(tx, req, access, {
          action: "finding.status",
          entityType: "finding",
          entityId: before.id,
          data: { from: before.status, to: req.body.status, note: req.body.note },
        });
        return findingJson(f!);
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/findings/:findingId/explanations",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["analytics"],
        summary: "Ask the AI assistant to explain a finding (asynchronous)",
        params: findingParams,
        response: { 202: z.object({ explanationId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const id = await withBuildingContext(
        db,
        req,
        req.params,
        "finding:explain",
        async (tx, access, ctx) => {
          const [f] = await tx
            .select()
            .from(schema.findings)
            .where(
              and(
                eq(schema.findings.id, req.params.findingId),
                eq(schema.findings.buildingId, ctx.building.id),
              ),
            );
          if (!f) throw notFound("Finding");
          const [pending] = await tx
            .select({ id: schema.aiExplanations.id })
            .from(schema.aiExplanations)
            .where(
              and(eq(schema.aiExplanations.findingId, f.id), eq(schema.aiExplanations.status, "pending")),
            );
          if (pending) return pending.id;
          const [e] = await tx
            .insert(schema.aiExplanations)
            .values({
              orgId: access.orgId,
              findingId: f.id,
              promptVersion: "pending",
              input: {},
              requestedBy: access.actor.type === "user" ? access.actor.id : null,
            })
            .returning({ id: schema.aiExplanations.id });
          await audit(tx, req, access, { action: "finding.explain", entityType: "finding", entityId: f.id });
          return e!.id;
        },
      );
      await jobs.explain({ orgId: req.params.orgId, explanationId: id });
      return reply.status(202).send({ explanationId: id });
    },
  );

  // ---- time series for charts ----------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/daily",
    {
      schema: {
        tags: ["analytics"],
        summary: "Daily figures per floor",
        params: buildingParams,
        querystring: z.object({ from: dateKey.optional(), to: dateKey.optional(), floorId: uuid.optional() }),
        response: {
          200: z.array(
            z.object({
              floorId: uuid,
              day: z.string(),
              dayType,
              kwhTotal: z.number(),
              kwhAfterHours: z.number(),
              kwhMeasured: z.number(),
              cost: z.number(),
              afterHoursPeak: z.number(),
              afterHoursHvacHours: z.number(),
              avoidableKwh: z.number(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "usage:read", async (tx, access, ctx) => {
        const range = dateRange(req.query.from, req.query.to, todayIn(ctx.building.timezone), 28);
        if (!range) throw badRequest("Choose between 1 and 400 days.");
        const visible = await visibleFloorIds(tx, access, ctx.building.id, todayIn(ctx.building.timezone));
        if (visible && req.query.floorId && !visible.has(req.query.floorId)) throw notFound("Floor");
        const rows = await tx
          .select()
          .from(schema.floorDaily)
          .where(
            and(
              eq(schema.floorDaily.buildingId, ctx.building.id),
              gte(schema.floorDaily.day, range.from),
              lt(schema.floorDaily.day, range.to),
              req.query.floorId ? eq(schema.floorDaily.floorId, req.query.floorId) : undefined,
              visible
                ? inArray(schema.floorDaily.floorId, [...visible, "00000000-0000-0000-0000-000000000000"])
                : undefined,
            ),
          )
          .orderBy(schema.floorDaily.day);
        return rows.map((r) => ({
          floorId: r.floorId,
          day: r.day,
          dayType: r.dayType,
          kwhTotal: r.kwhTotal,
          kwhAfterHours: r.kwhAfterHours,
          kwhMeasured: r.kwhMeasured,
          cost: r.cost,
          afterHoursPeak: r.afterHoursPeak,
          afterHoursHvacHours: r.afterHoursHvacHours,
          avoidableKwh: r.avoidableKwh,
        }));
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/floors/:floorId/intervals",
    {
      schema: {
        tags: ["analytics"],
        summary: "15-minute intervals of one floor on one local day (evidence charts)",
        params: buildingParams.extend({ floorId: uuid }),
        querystring: z.object({ date: dateKey }),
        response: {
          200: z.array(
            z.object({
              start: z.string(),
              minutes: z.number(),
              occupancy: z.number(),
              hvacMode: z.string(),
              hvacOn: z.number(),
              lightsOn: z.number(),
              kwhHvac: z.number(),
              kwhLighting: z.number(),
              kwhPlug: z.number(),
              tier: z.string(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "usage:read", async (tx, access, ctx) => {
        const visible = await visibleFloorIds(tx, access, ctx.building.id, todayIn(ctx.building.timezone));
        if (
          (visible && !visible.has(req.params.floorId)) ||
          !ctx.floors.some((f) => f.id === req.params.floorId)
        )
          throw notFound("Floor");
        const tz = ctx.building.timezone;
        const rows = await tx
          .select()
          .from(schema.floorIntervals)
          .where(
            and(
              eq(schema.floorIntervals.floorId, req.params.floorId),
              gte(schema.floorIntervals.startAt, new Date(zonedTime(req.query.date, 0, tz))),
              lt(schema.floorIntervals.startAt, new Date(zonedTime(addDaysKey(req.query.date, 1), 0, tz))),
            ),
          )
          .orderBy(schema.floorIntervals.startAt);
        return rows.map((r) => ({
          start: r.startAt.toISOString(),
          minutes: r.minutes,
          occupancy: r.occupancy,
          hvacMode: r.hvacMode,
          hvacOn: r.hvacOn,
          lightsOn: r.lightsOn,
          kwhHvac: r.kwhHvac,
          kwhLighting: r.kwhLighting,
          kwhPlug: r.kwhPlug,
          tier: r.tier,
        }));
      }),
  );

  // ---- forecasts -----------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/forecasts",
    {
      schema: {
        tags: ["analytics"],
        summary: "After-hours headcount forecast per floor and the suggested cooling schedule",
        params: buildingParams,
        querystring: z.object({
          from: dateKey.optional(),
          days: z.coerce.number().int().min(1).max(14).default(7),
        }),
        response: {
          200: z.array(
            z.object({
              floorId: uuid,
              day: z.string(),
              dayType,
              median: z.number(),
              low: z.number(),
              high: z.number(),
              basis: z.number(),
              advice: z.enum(["on_demand", "setback", "off"]),
              adviceLabel: z.string(),
              method: z.string(),
              generatedAt: z.string(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "forecast:read", async (tx, _a, ctx) => {
        const today = todayIn(ctx.building.timezone);
        let start = req.query.from;
        if (!start) {
          const [latest] = await tx
            .select({ d: sql<string | null>`max(${schema.forecasts.day})::text` })
            .from(schema.forecasts)
            .where(eq(schema.forecasts.buildingId, ctx.building.id));
          // with no forecast reaching today (e.g. historical demo data) show the latest forecast week
          start = latest?.d && latest.d < today ? addDaysKey(latest.d, -(req.query.days - 1)) : today;
        }
        const rows = await tx
          .select()
          .from(schema.forecasts)
          .where(
            and(
              eq(schema.forecasts.buildingId, ctx.building.id),
              gte(schema.forecasts.day, start),
              lt(schema.forecasts.day, addDaysKey(start, req.query.days)),
            ),
          )
          .orderBy(schema.forecasts.day);
        return rows.map((r) => ({
          floorId: r.floorId,
          day: r.day,
          dayType: r.dayType,
          median: r.median,
          low: r.low,
          high: r.high,
          basis: r.basis,
          advice: r.advice,
          adviceLabel: SCHEDULE_LABELS[r.advice],
          method: r.method,
          generatedAt: r.generatedAt.toISOString(),
        }));
      }),
  );

  // ---- strategies and finance ----------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/buildings/:buildingId/strategies",
    {
      schema: {
        tags: ["strategy"],
        summary: "Annual savings and capex per strategy, extrapolated from the findings in a window",
        params: buildingParams,
        querystring: z.object({ from: dateKey.optional(), to: dateKey.optional() }),
        response: {
          200: z.object({
            window: z.object({ from: z.string(), to: z.string(), observed: z.record(dayType, z.number()) }),
            tariff: z.number(),
            strategies: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string(),
                observedKwh: z.number(),
                annualKwh: z.number(),
                annualCost: z.number(),
                capex: z.number(),
                floors: z.number(),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "strategy:read", async (tx, _a, ctx) => {
        const end = (await latestDataDay(tx, ctx)) ?? todayIn(ctx.building.timezone);
        const range = dateRange(req.query.from, req.query.to, end, 28);
        if (!range) throw badRequest("Choose between 1 and 400 days.");
        const s = await strategySummary(tx, ctx, range.from, range.to);
        const tariff = averageRate(ctx.building.tariff);
        const desc = (id: string) =>
          (STRATEGIES as Record<string, { description: string }>)[id]?.description ??
          "All three strategies together.";
        return {
          window: s.window,
          tariff,
          strategies: s.strategies.map((e) => ({
            ...e,
            description: desc(e.id),
            annualCost: Math.round(e.annualKwh * tariff),
          })),
        };
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/epc",
    {
      schema: {
        tags: ["strategy"],
        summary: "Evaluate an energy performance contract or a self-funded project for a strategy",
        description:
          "Unspecified annual kWh and capex come from the strategy estimate over the last 28 days of data; the tariff defaults to the building's average rate.",
        params: buildingParams,
        body: epcInputs,
        response: { 200: epcOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "strategy:read", async (tx, _a, ctx) => {
        const i = req.body;
        let { annualKwh, capex } = i;
        if (annualKwh === undefined || capex === undefined) {
          const end = (await latestDataDay(tx, ctx)) ?? todayIn(ctx.building.timezone);
          const s = await strategySummary(tx, ctx, addDaysKey(end, -27), addDaysKey(end, 1));
          const est = s.strategies.find((e) => e.id === i.strategyId);
          if (!est) throw unprocessable("No estimate for this strategy.");
          annualKwh ??= est.annualKwh;
          capex ??= est.capex;
        }
        const tariff = i.tariff ?? averageRate(ctx.building.tariff);
        const r = evaluateEpc({ ...i, annualKwh, capex, tariff });
        return {
          ...r,
          inputs: {
            strategyId: i.strategyId,
            annualKwh,
            capex,
            tariff,
            achieved: i.achieved,
            escoShare: i.escoShare,
            years: i.years,
            discountRate: i.discountRate,
            annualOpex: i.annualOpex,
          },
          escoPaybackYears: finite(r.escoPaybackYears),
          selfFundedPaybackYears: finite(r.selfFundedPaybackYears),
        };
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/scenarios",
    {
      schema: {
        tags: ["strategy"],
        summary: "Saved scenarios",
        params: buildingParams,
        response: {
          200: z.array(
            z.object({
              id: uuid,
              name: z.string(),
              strategyId: z.string(),
              inputs: z.record(z.string(), z.number()),
              createdAt: z.string(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "strategy:read", async (tx, _a, b) =>
        (
          await tx
            .select()
            .from(schema.epcScenarios)
            .where(eq(schema.epcScenarios.buildingId, b.id))
            .orderBy(desc(schema.epcScenarios.createdAt))
        ).map((s) => ({
          id: s.id,
          name: s.name,
          strategyId: s.strategyId,
          inputs: s.inputs,
          createdAt: s.createdAt.toISOString(),
        })),
      ),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/scenarios",
    {
      schema: {
        tags: ["strategy"],
        summary: "Save a scenario (inputs only; results are recomputed when viewed)",
        params: buildingParams,
        body: z.object({ name: z.string().trim().min(1).max(120), inputs: epcInputs }),
        response: { 201: z.object({ id: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const id = await inBuilding(db, req, req.params, "scenario:write", async (tx, access, b) => {
        const { strategyId, ...numbers } = req.body.inputs;
        const [s] = await tx
          .insert(schema.epcScenarios)
          .values({
            orgId: access.orgId,
            buildingId: b.id,
            name: req.body.name,
            strategyId,
            inputs: Object.fromEntries(Object.entries(numbers).filter(([, v]) => v !== undefined)) as Record<
              string,
              number
            >,
            createdBy: access.actor.type === "user" ? access.actor.id : null,
          })
          .returning({ id: schema.epcScenarios.id });
        await audit(tx, req, access, {
          action: "scenario.create",
          entityType: "epc_scenario",
          entityId: s!.id,
          data: req.body,
        });
        return s!.id;
      });
      return reply.status(201).send({ id });
    },
  );

  app.delete(
    "/orgs/:orgId/buildings/:buildingId/scenarios/:scenarioId",
    {
      schema: {
        tags: ["strategy"],
        summary: "Delete a scenario",
        params: buildingParams.extend({ scenarioId: uuid }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "scenario:write", async (tx, access, b) => {
        const gone = await tx
          .delete(schema.epcScenarios)
          .where(
            and(eq(schema.epcScenarios.id, req.params.scenarioId), eq(schema.epcScenarios.buildingId, b.id)),
          )
          .returning({ id: schema.epcScenarios.id });
        if (!gone.length) throw notFound("Scenario");
        await audit(tx, req, access, {
          action: "scenario.delete",
          entityType: "epc_scenario",
          entityId: req.params.scenarioId,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- reports -------------------------------------------------------------------------------------------
  const reportJson = (r: Awaited<ReturnType<typeof buildingReport>>) => ({
    ...r,
    period: {
      ...r.period,
      from: new Date(r.period.from).toISOString(),
      to: new Date(r.period.to).toISOString(),
    },
    scope2: { ...r.scope2, residualFactor: r.scope2.residualFactor ?? null },
  });

  app.get(
    "/orgs/:orgId/buildings/:buildingId/report",
    {
      schema: {
        tags: ["carbon"],
        summary: "Energy and carbon report for whole local days (JSON, or CSV with format=csv)",
        params: buildingParams,
        querystring: z.object({
          from: dateKey.optional(),
          to: dateKey.optional(),
          format: z.enum(["json", "csv"]).default("json"),
        }),
        response: { 200: reportOut.or(z.string()), ...errorResponses },
      },
    },
    async (req, reply) => {
      const report = await withBuildingContext(db, req, req.params, "report:read", async (tx, _a, ctx) => {
        const end = (await latestDataDay(tx, ctx)) ?? todayIn(ctx.building.timezone);
        const range = dateRange(req.query.from, req.query.to, end, 28);
        if (!range) throw badRequest("Choose between 1 and 400 days.");
        return {
          report: await buildingReport(tx, ctx, range.from, range.to),
          range,
          name: ctx.building.name,
        };
      });
      if (req.query.format === "csv") {
        const r = report.report;
        const esc = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
        const lines = [
          ["section", "item", "kwh", "after_hours_kwh", "avoidable_kwh", "cost", "co2e_kg"].join(","),
          [
            "total",
            esc(report.name),
            r.totals.kwh,
            r.totals.afterHoursKwh,
            r.totals.avoidableKwh,
            r.totals.cost,
            r.scope2.locationBasedKg,
          ].join(","),
          ...r.byFloor.map((f) =>
            ["floor", esc(f.label), f.kwh, f.afterHoursKwh, f.avoidableKwh, "", ""].join(","),
          ),
          ...r.byDayType.map((d) => ["day_type", d.dayType, d.kwh, "", d.avoidableKwh, "", ""].join(",")),
          ...r.byRule.map((x) => ["rule", esc(x.name), "", "", x.kwh, "", ""].join(",")),
          ["scope2", "location_based", r.scope2.kwh, "", "", "", r.scope2.locationBasedKg].join(","),
          ["scope2", "market_based", r.scope2.kwh, "", "", "", r.scope2.marketBasedKg].join(","),
          ...r.disclosures.map((d) => ["disclosure", esc(d), "", "", "", "", ""].join(",")),
        ];
        return reply
          .header(
            "content-disposition",
            `attachment; filename="flowcarbon-report-${report.range.from}-${report.range.to}.csv"`,
          )
          .type("text/csv; charset=utf-8")
          .send(`﻿${lines.join("\r\n")}\r\n`);
      }
      return reportJson(report.report);
    },
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/report-snapshots",
    {
      schema: {
        tags: ["carbon"],
        summary: "Freeze a report as signed off; later data corrections do not change it",
        params: buildingParams,
        body: z.object({ from: dateKey, to: dateKey, note: z.string().trim().max(1000).optional() }),
        response: { 201: z.object({ id: uuid, createdAt: z.string() }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const snap = await withBuildingContext(
        db,
        req,
        req.params,
        "report:snapshot",
        async (tx, access, ctx) => {
          const range = dateRange(req.body.from, req.body.to, todayIn(ctx.building.timezone), 28);
          if (!range) throw badRequest("Choose between 1 and 400 days.");
          const r = await buildingReport(tx, ctx, range.from, range.to);
          const [s] = await tx
            .insert(schema.reportSnapshots)
            .values({
              orgId: access.orgId,
              buildingId: ctx.building.id,
              periodFrom: new Date(r.period.from),
              periodTo: new Date(r.period.to),
              data: { report: reportJson(r), note: req.body.note ?? null, building: ctx.building.name },
              createdBy: access.actor.type === "user" ? access.actor.id : null,
            })
            .returning();
          await audit(tx, req, access, {
            action: "report.snapshot",
            entityType: "report_snapshot",
            entityId: s!.id,
            data: { from: range.from, to: range.to },
          });
          return s!;
        },
      );
      return reply.status(201).send({ id: snap.id, createdAt: snap.createdAt.toISOString() });
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/report-snapshots",
    {
      schema: {
        tags: ["carbon"],
        summary: "Frozen reports",
        params: buildingParams,
        response: {
          200: z.array(
            z.object({
              id: uuid,
              periodFrom: z.string(),
              periodTo: z.string(),
              createdAt: z.string(),
              createdBy: uuid.nullable(),
            }),
          ),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "report:read", async (tx, _a, b) =>
        (
          await tx
            .select({
              id: schema.reportSnapshots.id,
              periodFrom: schema.reportSnapshots.periodFrom,
              periodTo: schema.reportSnapshots.periodTo,
              createdAt: schema.reportSnapshots.createdAt,
              createdBy: schema.reportSnapshots.createdBy,
            })
            .from(schema.reportSnapshots)
            .where(eq(schema.reportSnapshots.buildingId, b.id))
            .orderBy(desc(schema.reportSnapshots.createdAt))
        ).map((s) => ({
          ...s,
          periodFrom: s.periodFrom.toISOString(),
          periodTo: s.periodTo.toISOString(),
          createdAt: s.createdAt.toISOString(),
        })),
      ),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/report-snapshots/:snapshotId",
    {
      schema: {
        tags: ["carbon"],
        summary: "A frozen report",
        params: buildingParams.extend({ snapshotId: uuid }),
        response: {
          200: z.object({ id: uuid, createdAt: z.string(), data: z.record(z.string(), z.unknown()) }),
          ...errorResponses,
        },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "report:read", async (tx, _a, b) => {
        const [s] = await tx
          .select()
          .from(schema.reportSnapshots)
          .where(
            and(
              eq(schema.reportSnapshots.id, req.params.snapshotId),
              eq(schema.reportSnapshots.buildingId, b.id),
            ),
          );
        if (!s) throw notFound("Snapshot");
        return { id: s.id, createdAt: s.createdAt.toISOString(), data: s.data };
      }),
  );
};
