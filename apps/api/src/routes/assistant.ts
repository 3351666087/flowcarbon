import { adoptTurn, NO_AI } from "@flowcarbon/core";
import { schema, type Tx, withOrg } from "@flowcarbon/db";
import { planData, strategyBoard } from "@flowcarbon/pipeline";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { aiQuotaLeft } from "../ai-quota";
import type { RouteDeps } from "../app";
import {
  applyTurn,
  dayFigures,
  planMetricsOut,
  planOptionId,
  planOut,
  settleLostTurns,
  type TurnRow,
  templateTurn,
  turnJson,
  turnOut,
  turnsJson,
  undoTurn,
} from "../assistant";
import { audit } from "../audit";
import { notFound, unprocessable } from "../errors";
import { holdAdopting, userOf } from "../measures";
import { buildingParams, errorResponses, iso, localeSchema, uuid } from "../schemas";
import { inBuilding, withBuildingContext } from "./helpers";

const turnParams = buildingParams.extend({ turnId: uuid });
/** the language to read turns in: finished ones in another are told again from their plan */
const readLocale = { locale: localeSchema.optional() };

/** how many applied options the board lists */
const APPLIED_SHOWN = 20;

const boardOut = z.object({
  /** the options still open, with no target, each on top of what is adopted */
  plan: planOut,
  /** the measures planned or in effect, and the building's figures with them in place */
  adopted: z.object({
    measures: z.array(
      z.object({
        id: uuid,
        floorId: uuid,
        strategyId: z.string(),
        originRuleId: z.string(),
        status: z.enum(["planned", "in_effect"]),
        coveredKwh: z.number(),
        findings: z.number(),
        byDayType: dayFigures,
      }),
    ),
    after: planMetricsOut,
  }),
  /** the coming days without and with the adopted measures; subtract `coverage` for a selected option */
  week: z.object({
    days: z.array(
      z.object({
        date: z.string(),
        dayType: z.enum(["workday", "weekend", "holiday"]),
        /** days of this kind the figures rest on */
        basis: z.number(),
        withoutKwh: z.number(),
        withKwh: z.number(),
        lowKwh: z.number(),
        highKwh: z.number(),
      }),
    ),
    coverage: z.array(z.object({ option: planOptionId, strategyId: z.string(), perDayKwh: dayFigures })),
  }),
  /** options applied and not undone, newest first: the turn to undo each with */
  applied: z.array(
    z.object({
      turnId: uuid,
      option: planOptionId,
      appliedAt: z.string().nullable(),
      measureIds: z.array(uuid),
    }),
  ),
});

async function oneTurn(tx: Tx, orgId: string, buildingId: string, turnId: string): Promise<TurnRow> {
  const [row] = await tx
    .select()
    .from(schema.assistantTurns)
    .where(
      and(
        eq(schema.assistantTurns.id, turnId),
        eq(schema.assistantTurns.orgId, orgId),
        eq(schema.assistantTurns.buildingId, buildingId),
      ),
    );
  if (!row) throw notFound("Turn");
  return row;
}

/**
 * The assistant and the strategy board. The numbers are the planner's, from the building's own data; a model only
 * reads the request and writes around them, and with no model the same plan arrives with templated words.
 */
export const assistantRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, jobs, config }) => {
  app.post(
    "/orgs/:orgId/buildings/:buildingId/assistant",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["strategy"],
        summary: "Ask the assistant for a plan, a command or an answer (asynchronous, streamed)",
        params: buildingParams,
        body: z.object({ prompt: z.string().trim().min(1).max(500), locale: localeSchema }),
        response: { 202: z.object({ turnId: uuid }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const id = await inBuilding(db, req, req.params, "finding:explain", async (tx, access, b) => {
        // the plan needs no model: past the quota the same plan arrives with templated words
        const asksModel = await aiQuotaLeft(tx, access.orgId, config.DEMO_AI_PER_DAY);
        const [row] = await tx
          .insert(schema.assistantTurns)
          .values({
            orgId: access.orgId,
            buildingId: b.id,
            requestedBy: userOf(access),
            locale: req.body.locale,
            prompt: req.body.prompt,
            promptVersion: asksModel ? "pending" : NO_AI,
          })
          .returning({ id: schema.assistantTurns.id });
        await audit(tx, req, access, {
          action: "assistant.ask",
          entityType: "assistant_turn",
          entityId: row!.id,
          data: { locale: req.body.locale },
        });
        return row!.id;
      });
      try {
        await jobs.assistant({ orgId: req.params.orgId, turnId: id });
      } catch (err) {
        // nothing will ever answer it, so it goes: the person gets their prompt back and an error
        await withOrg(db, req.params.orgId, (tx) =>
          tx
            .delete(schema.assistantTurns)
            .where(and(eq(schema.assistantTurns.id, id), eq(schema.assistantTurns.orgId, req.params.orgId))),
        ).catch((cleanup) => req.log.error({ err: cleanup, turnId: id }, "turn with no job not removed"));
        throw err;
      }
      return reply.status(202).send({ turnId: id });
    },
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/assistant/turns",
    {
      schema: {
        tags: ["strategy"],
        summary: "The building's latest exchanges with the assistant, newest last",
        params: buildingParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), ...readLocale }),
        response: { 200: z.object({ items: z.array(turnOut) }), ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, access, b) => {
        const rows = await tx
          .select()
          .from(schema.assistantTurns)
          .where(
            and(eq(schema.assistantTurns.orgId, access.orgId), eq(schema.assistantTurns.buildingId, b.id)),
          )
          .orderBy(desc(schema.assistantTurns.createdAt))
          .limit(req.query.limit);
        const turns = await settleLostTurns(tx, rows.reverse());
        return { items: await turnsJson(tx, b.id, turns, req.query.locale) };
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/assistant/turns/:turnId",
    {
      // polled about twice a second while the reply streams in
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["strategy"],
        summary: "One exchange, including the text written so far while it is pending",
        params: turnParams,
        querystring: z.object(readLocale),
        response: { 200: turnOut, ...errorResponses },
      },
    },
    async (req) =>
      inBuilding(db, req, req.params, "finding:read", async (tx, access, b) => {
        const row = await oneTurn(tx, access.orgId, b.id, req.params.turnId);
        const [turn] = await settleLostTurns(tx, [row]);
        return turnJson(tx, b.id, turn!, req.query.locale);
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/assistant/turns/:turnId/apply",
    {
      schema: {
        tags: ["strategy"],
        summary:
          "Apply one option of a turn: one measure per action, joining a measure already there. They take effect at once in a demo organisation and are planned elsewhere. Applying the same option again changes nothing.",
        params: turnParams,
        body: z.object({ option: planOptionId }),
        response: { 200: turnOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:review", async (tx, access, ctx) => {
        const row = await applyTurn(tx, req, access, ctx, req.params.turnId, req.body.option);
        return turnJson(tx, ctx.building.id, row);
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/assistant/turns/:turnId/undo",
    {
      schema: {
        tags: ["strategy"],
        summary: "Take back an applied option: cancels what applying created and reopens its findings",
        params: turnParams,
        response: { 200: turnOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:review", async (tx, access, ctx) => {
        const row = await undoTurn(tx, req, access, ctx, req.params.turnId);
        return turnJson(tx, ctx.building.id, row);
      }),
  );

  app.get(
    "/orgs/:orgId/buildings/:buildingId/strategy-board",
    {
      schema: {
        tags: ["strategy"],
        summary:
          "The strategies open to the building, what is already adopted and the week ahead. Computed from its data, with no AI.",
        params: buildingParams,
        response: { 200: boardOut, ...errorResponses },
      },
    },
    async (req) =>
      withBuildingContext(db, req, req.params, "finding:read", async (tx, access, ctx) => {
        const board = await strategyBoard(tx, ctx);
        const turns = await tx
          .select()
          .from(schema.assistantTurns)
          .where(
            and(
              eq(schema.assistantTurns.orgId, access.orgId),
              eq(schema.assistantTurns.buildingId, ctx.building.id),
              isNotNull(schema.assistantTurns.appliedOption),
            ),
          )
          .orderBy(desc(schema.assistantTurns.appliedAt));
        // a turn keeps what it applied after the measures are cancelled, and an option with none left is not applied
        const standing = new Set(board.adopted.measures.map((m) => m.id));
        const applied = turns.flatMap((t) => {
          const measureIds = (t.appliedMeasures ?? []).flatMap((m) =>
            standing.has(m.measureId) ? [m.measureId] : [],
          );
          if (!measureIds.length) return [];
          const option = t.appliedOption as z.infer<typeof planOptionId>;
          return [{ turnId: t.id, option, appliedAt: iso(t.appliedAt), measureIds }];
        });
        return { ...board, applied: applied.slice(0, APPLIED_SHOWN) };
      }),
  );

  app.post(
    "/orgs/:orgId/buildings/:buildingId/strategy-board/adopt",
    {
      schema: {
        tags: ["strategy"],
        summary: "Adopt an option straight from the board, through the same path as applying a turn",
        params: buildingParams,
        body: z.object({
          option: z.enum(["weekends", "weekdays", "balanced"]),
          locale: localeSchema.default("en"),
        }),
        response: { 201: turnOut, ...errorResponses },
      },
    },
    async (req, reply) => {
      const out = await withBuildingContext(
        db,
        req,
        req.params,
        "finding:review",
        async (tx, access, ctx) => {
          const { option: id, locale } = req.body;
          // before planning, so that a second person adopting at once plans on what the first one left
          await holdAdopting(tx, ctx.building.id);
          const plan = await planData(tx, ctx);
          const option = plan.options.find((o) => o.id === id);
          if (!option) throw unprocessable("That option is no longer open.", undefined, "option_closed");
          const turn = await templateTurn(tx, access, ctx, {
            ...adoptTurn(plan, option, { locale, floors: ctx.floors }),
            locale,
            intent: {
              kind: "command",
              target: null,
              focus: "all",
              floors: [],
              unknownFloors: [],
              days: "all",
              source: "board",
            },
            plan: { ...plan, options: [option] },
          });
          const row = await applyTurn(tx, req, access, ctx, turn.id, id);
          return turnJson(tx, ctx.building.id, row);
        },
      );
      return reply.status(201).send(out);
    },
  );
};
