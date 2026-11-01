import {
  type CommunityResult,
  communityEntry,
  communityResult,
  communitySummary,
  communityTitle,
  communityTurn,
  datasetName,
  namesPlaceOrTenant,
  type Plan,
  type PlanLocale,
  type PlanOption,
  statesAmount,
} from "@flowcarbon/core";
import { schema, type Tx, withOrg } from "@flowcarbon/db";
import { type BuildingContext, latestDataDay, planData } from "@flowcarbon/pipeline";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { planOptionId, planOut, type TurnRow, templateTurn } from "../assistant";
import { audit } from "../audit";
import { requireOrg } from "../auth/access";
import { conflict, HttpError, notFound, unprocessable } from "../errors";
import { userOf, verify } from "../measures";
import { buildingParams, errorResponses, localeBody, localeSchema, orgParams, uuid } from "../schemas";
import { addDaysKey, inBuilding, todayIn, withBuildingContext } from "./helpers";

/** how far behind today a building's data may be and still count as current */
const CURRENT_DATA_DAYS = 2;
/** complete days of the kind a strategy acts on before what it did counts as measured: about a working week */
const MEASURED_MIN_DAYS = 5;

type StrategyRow = typeof schema.communityStrategies.$inferSelect;

/** Everything another organisation sees: no organisation, building, person, floor or tenant behind it. */
const strategyOut = z.object({
  id: uuid,
  /** the author, as the publisher chose to appear */
  alias: z.string(),
  title: z.string(),
  summary: z.string(),
  locale: z.string(),
  optionKind: z.enum(["weekends", "weekdays", "balanced", "custom"]),
  strategyMix: z.array(z.object({ strategyId: z.string(), floorShare: z.number() })),
  floorsCount: z.number(),
  areaBand: z.string(),
  result: z.object({
    avoidableShareBefore: z.number(),
    avoidableShareAfter: z.number(),
    energyCutPct: z.number(),
    basis: z.enum(["expected", "measured"]),
    days: z.number(),
    /** the building behind it is simulated */
    simulated: z.boolean().optional(),
  }),
  uses: z.number(),
  createdAt: z.string(),
  /** published by the caller's organisation (from the building asked about, when one is given) */
  mine: z.boolean(),
  /** derived from a public dataset, not published by an organisation */
  publicDataset: z.boolean(),
});

/** A title from the template, which reads in any language, rather than one the publisher typed. */
const templated = (row: StrategyRow) =>
  row.title === communityTitle(row.optionKind, row.locale === "zh" ? "zh" : "en");

function strategyJson(
  row: StrategyRow,
  orgId: string,
  { locale, buildingId }: { locale?: PlanLocale; buildingId?: string } = {},
) {
  // the words come from templates, so they read in the language asked for; only a typed title stays as it was typed
  const text = locale
    ? {
        title: templated(row) ? communityTitle(row.optionKind, locale) : row.title,
        summary: communitySummary(row, locale),
        locale,
      }
    : { title: row.title, summary: row.summary, locale: row.locale };
  return {
    id: row.id,
    alias: row.orgId === null && locale ? datasetName(row.alias, locale) : row.alias,
    ...text,
    optionKind: row.optionKind,
    strategyMix: [...row.strategyMix],
    floorsCount: row.floorsCount,
    areaBand: row.areaBand,
    result: row.result,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
    mine: row.orgId === orgId && (!buildingId || row.buildingId === buildingId),
    publicDataset: row.orgId === null && !row.result.simulated,
  };
}

/**
 * What a publisher types reaches every organisation, and through "use this" their chat, so it may not name what a row
 * leaves out on purpose, however it is spelled. The alias may be the building's name, which is the publisher's to give;
 * a title is a label, so it holds no figures either, because the row's own figures are the only ones with a basis.
 */
function assertPublishable(ctx: BuildingContext, alias: string, title: string | undefined) {
  const labels = ctx.floors.map((f) => f.label);
  const tenants = ctx.tenants.map((t) => t.name);
  const identifies = (text: string) => namesPlaceOrTenant(text, { labels, tenants });
  const claims = (text: string) =>
    /\p{Nd}/u.test(text) || statesAmount(text) || /\b(?:measured|verified|proven)\b|实测|已验证/i.test(text);
  const named = (text: string) =>
    identifies(text) || namesPlaceOrTenant(text, { labels: [ctx.building.name] });
  if (identifies(alias) || (title && (named(title) || claims(title))))
    throw unprocessable(
      "An alias or a title cannot name a floor or a tenant, and a title cannot state figures.",
      undefined,
      "community_identifies",
    );
}

/**
 * A strategy that has run long enough reports what the data measured: `MEASURED_MIN_DAYS` complete days it acts on, so
 * one good day is not scaled up to a month. A simulated building never does, and neither does one whose data has
 * stopped, because days with no data would read as days with no waste.
 */
async function resultOf(
  tx: Tx,
  ctx: BuildingContext,
  plan: Plan,
  option: PlanOption,
  turn: TurnRow | undefined,
  simulated: boolean,
): Promise<CommunityResult> {
  const expected = communityEntry(plan, option, ctx.floors).result;
  const applied = turn?.appliedOption === option.id ? (turn.appliedMeasures ?? []) : [];
  if (simulated || !applied.length) return expected;
  const measures = await tx
    .select()
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.buildingId, ctx.building.id),
        inArray(
          schema.measures.id,
          applied.map((a) => a.measureId),
        ),
      ),
    );
  const lastDay = await latestDataDay(tx, ctx);
  if (measures.length !== applied.length) return expected;
  if (!lastDay || lastDay < addDaysKey(todayIn(ctx.building.timezone), -CURRENT_DATA_DAYS)) return expected;
  let weeklyKwh = 0;
  let days = Number.POSITIVE_INFINITY;
  for (const m of measures) {
    if (m.status !== "in_effect") return expected;
    const { after, weekly } = await verify(tx, ctx, m);
    if (!after || after.days < MEASURED_MIN_DAYS) return expected;
    weeklyKwh += weekly.kwh;
    days = Math.min(days, after.days);
  }
  return communityResult(plan, (weeklyKwh / 7) * plan.window.days, "measured", days);
}

async function openStrategy(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(schema.communityStrategies)
    .where(and(eq(schema.communityStrategies.id, id), isNull(schema.communityStrategies.withdrawnAt)));
  if (!row) throw notFound("Strategy");
  return row;
}

/**
 * Strategies buildings share with each other. Reading crosses organisations on purpose (and only here); writing stays
 * with the organisation that published, which row-level security enforces underneath these checks.
 */
export const communityRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, config }) => {
  app.get(
    "/orgs/:orgId/community/strategies",
    {
      schema: {
        tags: ["strategy"],
        summary: "Strategies shared by other buildings, and from public datasets",
        params: orgParams,
        querystring: z.object({
          sort: z.enum(["recent", "used"]).default("recent"),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          locale: localeSchema.optional(),
          /** the building looking: strategies are published per building, so this is what `mine` is about */
          buildingId: uuid.optional(),
        }),
        response: { 200: z.object({ items: z.array(strategyOut) }), ...errorResponses },
      },
    },
    async (req) => {
      const access = await requireOrg(db, req, req.params.orgId, "org:read");
      const { sort, limit, locale, buildingId } = req.query;
      return withOrg(db, req.params.orgId, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.communityStrategies)
          // an organisation can still read its own withdrawn rows, so this is not left to the policies
          .where(isNull(schema.communityStrategies.withdrawnAt))
          .orderBy(
            ...(sort === "used"
              ? [desc(schema.communityStrategies.uses), desc(schema.communityStrategies.createdAt)]
              : [desc(schema.communityStrategies.createdAt)]),
          )
          .limit(limit);
        return { items: rows.map((r) => strategyJson(r, access.orgId, { locale, buildingId })) };
      });
    },
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/community/strategies",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["strategy"],
        summary:
          "Share one of the building's options with other buildings: the mix of strategies and its result, under an alias. No floors, tenants or building name are published.",
        params: buildingParams,
        body: z.object({
          option: planOptionId,
          alias: z.string().trim().min(2).max(60),
          title: z.string().trim().min(2).max(120).optional(),
          /** the turn the option came from; an option already applied is no longer on the open plan */
          turnId: uuid.optional(),
          locale: localeSchema.optional(),
        }),
        response: { 201: strategyOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const out = await withBuildingContext(
        db,
        req,
        req.params,
        "finding:review",
        async (tx, access, ctx) => {
          const b = req.body;
          assertPublishable(ctx, b.alias, b.title);
          const [org] = await tx
            .select({ slug: schema.organizations.slug, plan: schema.organizations.plan })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, access.orgId));
          if (config.DEMO_ORG_SLUG && org?.slug === config.DEMO_ORG_SLUG)
            throw new HttpError(
              403,
              "The shared demonstration is read-only. Share a strategy from a building of your own.",
              "community_demo",
            );
          const [turn] = b.turnId
            ? await tx
                .select()
                .from(schema.assistantTurns)
                .where(
                  and(
                    eq(schema.assistantTurns.id, b.turnId),
                    eq(schema.assistantTurns.orgId, access.orgId),
                    eq(schema.assistantTurns.buildingId, ctx.building.id),
                  ),
                )
            : [];
          if (b.turnId && !turn) throw notFound("Turn");
          const plan = turn?.plan ?? (await planData(tx, ctx));
          const option = plan.options.find((o) => o.id === b.option);
          if (!option) throw unprocessable("This building has no such option.", undefined, "option_closed");

          const simulated = org?.plan === "demo";
          const result = await resultOf(tx, ctx, plan, option, turn, simulated);
          const entry = {
            ...communityEntry(plan, option, ctx.floors),
            result: simulated ? { ...result, simulated } : result,
          };
          const [same] = await tx
            .select({ id: schema.communityStrategies.id })
            .from(schema.communityStrategies)
            .where(
              and(
                eq(schema.communityStrategies.orgId, access.orgId),
                eq(schema.communityStrategies.buildingId, ctx.building.id),
                eq(schema.communityStrategies.optionKind, entry.optionKind),
                isNull(schema.communityStrategies.withdrawnAt),
              ),
            );
          if (same)
            throw conflict(
              "This building already shares this strategy. Withdraw it first.",
              "community_shared",
            );

          const locale: PlanLocale = (b.locale ?? turn?.locale) === "zh" ? "zh" : "en";
          const [row] = await tx
            .insert(schema.communityStrategies)
            .values({
              ...entry,
              orgId: access.orgId,
              buildingId: ctx.building.id,
              alias: b.alias,
              title: b.title ?? communityTitle(entry.optionKind, locale),
              summary: communitySummary(entry, locale),
              locale,
              publishedBy: userOf(access),
            })
            .returning();
          await audit(tx, req, access, {
            action: "community.publish",
            entityType: "community_strategy",
            entityId: row!.id,
            data: { option: b.option, alias: b.alias, basis: entry.result.basis },
          });
          return strategyJson(row!, access.orgId);
        },
      );
      return reply.status(201).send(out);
    },
  );

  const strategyParams = buildingParams.extend({ id: uuid });

  app.delete(
    "/orgs/:orgId/buildings/:buildingId/community/strategies/:id",
    {
      schema: {
        tags: ["strategy"],
        summary: "Withdraw a strategy this building shared",
        params: strategyParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await inBuilding(db, req, req.params, "finding:review", async (tx, access, b) => {
        const done = await tx
          .update(schema.communityStrategies)
          .set({ withdrawnAt: new Date() })
          .where(
            and(
              eq(schema.communityStrategies.id, req.params.id),
              eq(schema.communityStrategies.orgId, access.orgId),
              eq(schema.communityStrategies.buildingId, b.id),
              isNull(schema.communityStrategies.withdrawnAt),
            ),
          )
          .returning({ id: schema.communityStrategies.id });
        if (!done.length) throw notFound("Strategy");
        await audit(tx, req, access, {
          action: "community.withdraw",
          entityType: "community_strategy",
          entityId: req.params.id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/community/strategies/:id/plan",
    {
      schema: {
        tags: ["strategy"],
        summary:
          "What a shared strategy would do on this building, for someone who may only look: nothing is stored.",
        params: strategyParams,
        response: { 200: z.object({ plan: planOut }), ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:read", async (tx, _access, ctx) => {
        const row = await openStrategy(tx, req.params.id);
        return { plan: await planData(tx, ctx, { only: row.strategyMix }) };
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/community/strategies/:id/use",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["strategy"],
        summary:
          "Plan a shared strategy on this building, as a turn to preview or apply. No AI and no quota, but a turn is written to the building's transcript, so it needs the same permission as asking. It counts as used once applied.",
        params: strategyParams,
        body: localeBody,
        response: { 201: z.object({ turnId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const turnId = await withBuildingContext(
        db,
        req,
        req.params,
        "finding:explain",
        async (tx, access, ctx) => {
          const row = await openStrategy(tx, req.params.id);
          // a seeded row is no one's, so even the building behind it can try it
          if (row.orgId === access.orgId && row.buildingId === ctx.building.id)
            throw conflict("This building published that strategy.", "community_own");
          const { locale } = req.body;
          const plan = await planData(tx, ctx, { only: row.strategyMix });
          const { title, alias } = strategyJson(row, access.orgId, { locale });
          const turn = await templateTurn(tx, access, ctx, {
            ...communityTurn(plan, { title, alias }, { locale, floors: ctx.floors }),
            locale,
            intent: {
              kind: "plan",
              target: null,
              focus: "all",
              floors: [],
              unknownFloors: [],
              days: "all",
              source: "community",
              communityId: row.id,
              strategy: {
                alias: row.alias,
                kind: row.optionKind,
                title: templated(row) ? null : row.title,
              },
            },
            plan,
          });
          await audit(tx, req, access, {
            action: "community.use",
            entityType: "community_strategy",
            entityId: row.id,
            data: { turnId: turn.id },
          });
          return turn.id;
        },
      );
      return reply.status(201).send({ turnId });
    },
  );
};
