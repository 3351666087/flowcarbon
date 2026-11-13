import {
  buildingFigures,
  COMPARE_MIN_COVERAGE,
  minCoveredDays,
  type WindowFigures,
  windowChange,
} from "@flowcarbon/core";
import { schema, withOrg } from "@flowcarbon/db";
import { buildingReport, latestDataDay, loadBuildingContext } from "@flowcarbon/pipeline";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { requireOrg } from "../auth/access";
import { buildingMeasureTotals } from "../measures";
import { errorResponses, orgParams, uuid } from "../schemas";
import { addDaysKey, todayIn } from "./helpers";

/** at most this many buildings are compared in one request */
export const COMPARE_MAX_BUILDINGS = 50;

const windowOut = z.object({
  /** days in the window that have data */
  days: z.number(),
  kwh: z.number(),
  afterHoursKwh: z.number(),
  avoidableKwh: z.number(),
  /** in the building's own currency: never summed or ranked across buildings */
  cost: z.number(),
  /** share of the energy that was metered rather than estimated */
  measuredShare: z.number(),
  /** kWh per m² of entered floor area per day with data */
  kwhPerM2Day: z.number().nullable(),
  afterHoursShare: z.number().nullable(),
  avoidableShare: z.number().nullable(),
  afterHoursPerDay: z.number().nullable(),
});

const compareOut = z.object({
  window: z.object({
    days: z.number(),
    /** [from, to) local dates, ending at the last whole day of the organisation's latest data */
    from: z.string(),
    to: z.string(),
    previousFrom: z.string(),
    previousTo: z.string(),
    /** a change needs at least this many days with data in each window */
    minDays: z.number(),
    minCoverage: z.number(),
  }),
  /** the organisation is a demo: every figure, measured ones included, is simulated */
  simulated: z.boolean(),
  /** more buildings exist than were compared */
  truncated: z.boolean(),
  buildings: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      currency: z.string(),
      timezone: z.string(),
      floors: z.number(),
      /** the floor area entered for the building's floors */
      areaM2: z.number(),
      lastDataDay: z.string().nullable(),
      current: windowOut,
      previous: windowOut,
      /** null where there is not enough data to compare, never 0 */
      change: z.object({
        kwhPerM2DayPct: z.number().nullable(),
        afterHoursPerDayPct: z.number().nullable(),
        afterHoursSharePp: z.number().nullable(),
        avoidableSharePp: z.number().nullable(),
      }),
      /** measures in effect: measured where the data since shows it, expected (with its range) otherwise */
      measures: z.object({
        inEffect: z.number(),
        measured: z.number(),
        measuredWeeklyKwh: z.number(),
        /** the fall in covered avoidable energy per day times the covered days since: not a meter reading */
        measuredToDateKwh: z.number(),
        expectedInEffect: z.number(),
        expectedWeeklyKwh: z.number(),
        expectedLowKwh: z.number(),
        expectedHighKwh: z.number(),
        expectedDays: z.number(),
      }),
    }),
  ),
});

export const compareRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.get(
    "/orgs/:orgId/compare",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Buildings of the organisation side by side over the same recent window",
        params: orgParams,
        querystring: z.object({ days: z.coerce.number().int().min(7).max(90).default(28) }),
        response: { 200: compareOut, ...errorResponses },
      },
    },
    async (req) => {
      const { orgId } = req.params;
      const days = req.query.days;
      // building-wide figures are for staff: tenant admins see their own floors elsewhere
      const access = await requireOrg(db, req, orgId, "report:read");
      return withOrg(db, orgId, async (tx) => {
        const [org] = await tx
          .select({ plan: schema.organizations.plan })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
        const rows = await tx
          .select({ id: schema.buildings.id })
          .from(schema.buildings)
          .where(
            and(
              isNull(schema.buildings.archivedAt),
              access.buildingId ? eq(schema.buildings.id, access.buildingId) : undefined,
            ),
          )
          .orderBy(schema.buildings.name)
          .limit(COMPARE_MAX_BUILDINGS + 1);
        const listed = rows.slice(0, COMPARE_MAX_BUILDINGS);

        const loaded = [];
        for (const r of listed) {
          const ctx = await loadBuildingContext(tx, orgId, r.id);
          const last = await latestDataDay(tx, ctx);
          const today = todayIn(ctx.building.timezone);
          // today is still coming in, so figures stop at the last whole day, as the overview's do
          const whole = last && last >= today ? addDaysKey(today, -1) : last;
          loaded.push({ ctx, last, whole, today });
        }
        // one window for every building, ending at the organisation's latest whole day: a building
        // whose data stopped shows fewer days with data, not a different period
        const ends = loaded.map((b) => b.whole).filter((d): d is string => !!d);
        const end = ends.length
          ? ends.reduce((a, b) => (a > b ? a : b))
          : addDaysKey(loaded[0]?.today ?? todayIn("UTC"), -1);
        const to = addDaysKey(end, 1);
        const from = addDaysKey(to, -days);
        const previousFrom = addDaysKey(from, -days);

        const buildings = [];
        for (const { ctx, last } of loaded) {
          const areaM2 = Math.round(ctx.floors.reduce((s, f) => s + f.areaM2, 0) * 10) / 10;
          const figures = async (a: string, b: string) => {
            const r = await buildingReport(tx, ctx, a, b);
            const w: WindowFigures = {
              days: r.period.days,
              kwh: r.totals.kwh,
              afterHoursKwh: r.totals.afterHoursKwh,
              avoidableKwh: r.totals.avoidableKwh,
            };
            return {
              w,
              out: {
                ...w,
                cost: r.totals.cost,
                measuredShare: r.totals.measuredShare,
                ...buildingFigures(w, areaM2),
              },
            };
          };
          const cur = await figures(from, to);
          const prev = await figures(previousFrom, from);
          const measures = await buildingMeasureTotals(tx, ctx);
          buildings.push({
            id: ctx.building.id,
            name: ctx.building.name,
            currency: ctx.building.currency,
            timezone: ctx.building.timezone,
            floors: ctx.floors.length,
            areaM2,
            lastDataDay: last,
            current: cur.out,
            previous: prev.out,
            change: windowChange(cur.w, prev.w, areaM2, days),
            measures: measures.inEffect,
          });
        }
        return {
          window: {
            days,
            from,
            to,
            previousFrom,
            previousTo: from,
            minDays: minCoveredDays(days),
            minCoverage: COMPARE_MIN_COVERAGE,
          },
          simulated: org?.plan === "demo",
          truncated: rows.length > COMPARE_MAX_BUILDINGS,
          buildings,
        };
      });
    },
  );
};
