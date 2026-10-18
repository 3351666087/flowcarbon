import { schema, withOrg } from "@flowcarbon/db";
import { API_KEY_SCOPES, newApiKey, randomToken, sha256 } from "@flowcarbon/security";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { audit } from "../audit";
import { orgAccess, requireOrg } from "../auth/access";
import { canGrant } from "../auth/permissions";
import { requireUser } from "../auth/principal";
import { createPersonalDemo, demoReady, personalDemoOf } from "../demo";
import { conflict, forbidden, notFound, unprocessable } from "../errors";
import { invitationMessage } from "../mail";
import {
  decodeCursor,
  encodeCursor,
  errorResponses,
  iso,
  orgParams,
  roleSchema,
  timestamp,
  uuid,
} from "../schemas";
import { slugFor } from "./auth";

const member = z.object({
  userId: uuid,
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  tenantId: uuid.nullable(),
  joinedAt: z.string(),
});
const invitation = z.object({
  id: uuid,
  email: z.string(),
  role: roleSchema,
  tenantId: uuid.nullable(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});
const apiKey = z.object({
  id: uuid,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  buildingId: uuid.nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
const factor = z.object({
  id: uuid,
  shared: z.boolean(),
  region: z.string(),
  year: z.number(),
  method: z.enum(["location", "market"]),
  kgPerKwh: z.number(),
  source: z.string(),
  status: z.enum(["verified", "to_verify"]),
});

export const orgRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, config, mailer, jobs }) => {
  // ---- creating and joining ------------------------------------------------------------------------------
  const created = z.object({ id: uuid, slug: z.string(), name: z.string() });

  app.post(
    "/orgs",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: {
        tags: ["organisation"],
        summary: "Create an organisation; the caller owns it",
        body: z.object({ name: z.string().trim().min(2).max(120) }),
        response: { 201: created, ...errorResponses },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const org = await db.transaction(async (tx) => {
        const [o] = await tx
          .insert(schema.organizations)
          .values({ name: req.body.name, slug: slugFor(req.body.name) })
          .returning({
            id: schema.organizations.id,
            slug: schema.organizations.slug,
            name: schema.organizations.name,
          });
        await tx.insert(schema.memberships).values({ orgId: o!.id, userId: u.userId, role: "owner" });
        await tx.execute(sql`select set_config('app.org_id', ${o!.id}, true)`);
        await audit(
          tx,
          req,
          { orgId: o!.id, actor: { type: "user", id: u.userId } },
          {
            action: "organisation.create",
            entityType: "organisation",
            entityId: o!.id,
            data: { name: o!.name },
          },
        );
        return o!;
      });
      return reply.status(201).send(org);
    },
  );

  app.post(
    "/orgs/demo",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: {
        tags: ["organisation"],
        summary:
          "The caller's own demo organisation with a simulated building, created on first call (the building is built in the background; `ready` says when it is there)",
        response: {
          200: created.extend({ ready: z.boolean() }),
          201: created.extend({ ready: z.boolean() }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      if (!config.DEMO_ORG_SLUG) throw notFound("Demo");
      let org = await personalDemoOf(db, u.userId);
      const created = !org;
      if (!org) {
        const [user] = await db
          .select({ id: schema.users.id, name: schema.users.name, locale: schema.users.locale })
          .from(schema.users)
          .where(eq(schema.users.id, u.userId));
        if (!user) throw notFound("User");
        org = await db.transaction((tx) =>
          createPersonalDemo(tx, user, {
            max: config.DEMO_WORKSPACES_MAX,
            ip: req.ip,
            requestId: String(req.id),
          }),
        );
      }
      const ready = await demoReady(db, org.id);
      // also when it exists but is still empty: a job that gave up gets another go
      if (!ready) await jobs.demo({ orgId: org.id });
      return reply.status(created ? 201 : 200).send({ ...org, ready });
    },
  );

  app.post(
    "/orgs/demo/join",
    {
      schema: {
        tags: ["organisation"],
        summary: "Join the demo organisation read-only (DEMO_ORG_SLUG), to explore with simulated data",
        response: { 200: created, ...errorResponses },
      },
    },
    async (req) => {
      const u = requireUser(req);
      if (!config.DEMO_ORG_SLUG) throw notFound("Demo organisation");
      const [org] = await db
        .select({
          id: schema.organizations.id,
          slug: schema.organizations.slug,
          name: schema.organizations.name,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, config.DEMO_ORG_SLUG));
      if (!org) throw notFound("Demo organisation");
      const [joined] = await db
        .insert(schema.memberships)
        .values({ orgId: org.id, userId: u.userId, role: "viewer" })
        .onConflictDoNothing()
        .returning({ orgId: schema.memberships.orgId });
      if (joined)
        await withOrg(db, org.id, (tx) =>
          audit(
            tx,
            req,
            { orgId: org.id, actor: { type: "user", id: u.userId } },
            {
              action: "member.join_demo",
              entityType: "membership",
              entityId: u.userId,
            },
          ),
        );
      return org;
    },
  );

  app.get(
    "/orgs/:orgId",
    {
      schema: {
        tags: ["organisation"],
        summary: "Organisation and the caller's role in it",
        params: orgParams,
        response: {
          200: z.object({
            id: uuid,
            slug: z.string(),
            name: z.string(),
            plan: z.string(),
            role: roleSchema.nullable(),
            tenantId: uuid.nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const access = await orgAccess(db, req, req.params.orgId);
      const [org] = await db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, req.params.orgId));
      if (!org) throw notFound("Organisation");
      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        plan: org.plan,
        role: access.role,
        tenantId: access.tenantId,
      };
    },
  );

  // ---- members -------------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/members",
    {
      schema: {
        tags: ["organisation"],
        summary: "List members",
        params: orgParams,
        response: { 200: z.array(member), ...errorResponses },
      },
    },
    async (req) => {
      await requireOrg(db, req, req.params.orgId, "members:manage");
      const rows = await db
        .select({
          userId: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.memberships.role,
          tenantId: schema.memberships.tenantId,
          joinedAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.orgId, req.params.orgId))
        .orderBy(schema.users.name);
      return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
    },
  );

  async function ownerCount(orgId: string) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.role, "owner")));
    return r?.n ?? 0;
  }

  async function assertTenant(orgId: string, tenantId: string | null | undefined) {
    if (!tenantId) return;
    const found = await withOrg(db, orgId, (tx) =>
      tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)),
    );
    if (!found.length) throw unprocessable("Unknown tenant.");
  }

  app.patch(
    "/orgs/:orgId/members/:userId",
    {
      schema: {
        tags: ["organisation"],
        summary: "Change a member's role",
        params: orgParams.extend({ userId: uuid }),
        body: z.object({ role: roleSchema, tenantId: uuid.nullable().optional() }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "members:manage");
      const { role, tenantId } = req.body;
      if (!canGrant(access.role!, role)) throw forbidden("You cannot grant this role.");
      if (role === "tenant_admin" && !tenantId)
        throw unprocessable("A tenant admin must be linked to a tenant.");
      await assertTenant(req.params.orgId, tenantId);
      const [current] = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, req.params.orgId),
            eq(schema.memberships.userId, req.params.userId),
          ),
        );
      if (!current) throw notFound("Member");
      if (current.role === "owner" && access.role !== "owner")
        throw forbidden("Only owners can change an owner.");
      if (current.role === "owner" && role !== "owner" && (await ownerCount(req.params.orgId)) <= 1)
        throw conflict("An organisation needs at least one owner.");
      await withOrg(db, req.params.orgId, async (tx) => {
        await tx
          .update(schema.memberships)
          .set({ role, tenantId: role === "tenant_admin" ? (tenantId ?? null) : null })
          .where(
            and(
              eq(schema.memberships.orgId, req.params.orgId),
              eq(schema.memberships.userId, req.params.userId),
            ),
          );
        await audit(tx, req, access, {
          action: "member.role",
          entityType: "membership",
          entityId: req.params.userId,
          data: { from: current.role, to: role },
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.delete(
    "/orgs/:orgId/members/:userId",
    {
      schema: {
        tags: ["organisation"],
        summary: "Remove a member",
        params: orgParams.extend({ userId: uuid }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "members:manage");
      const [current] = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, req.params.orgId),
            eq(schema.memberships.userId, req.params.userId),
          ),
        );
      if (!current) throw notFound("Member");
      if (current.role === "owner" && access.role !== "owner")
        throw forbidden("Only owners can remove an owner.");
      if (current.role === "owner" && (await ownerCount(req.params.orgId)) <= 1)
        throw conflict("An organisation needs at least one owner.");
      await withOrg(db, req.params.orgId, async (tx) => {
        await tx
          .delete(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, req.params.orgId),
              eq(schema.memberships.userId, req.params.userId),
            ),
          );
        await audit(tx, req, access, {
          action: "member.remove",
          entityType: "membership",
          entityId: req.params.userId,
          data: { role: current.role },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- invitations ---------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/invitations",
    {
      schema: {
        tags: ["organisation"],
        summary: "List invitations",
        params: orgParams,
        response: { 200: z.array(invitation), ...errorResponses },
      },
    },
    async (req) => {
      await requireOrg(db, req, req.params.orgId, "members:manage");
      const rows = await db
        .select()
        .from(schema.invitations)
        .where(eq(schema.invitations.orgId, req.params.orgId))
        .orderBy(desc(schema.invitations.createdAt));
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        tenantId: r.tenantId,
        expiresAt: r.expiresAt.toISOString(),
        acceptedAt: iso(r.acceptedAt),
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  app.post(
    "/orgs/:orgId/invitations",
    {
      schema: {
        tags: ["organisation"],
        summary:
          "Invite someone. The link is returned once, and emailed to the invitee when outgoing mail is configured (`emailed`).",
        params: orgParams,
        body: z.object({
          email: z.email().max(320),
          role: roleSchema,
          tenantId: uuid.nullable().optional(),
          expiresInDays: z.number().int().min(1).max(30).default(7),
        }),
        response: {
          201: z.object({ id: uuid, acceptUrl: z.string(), expiresAt: z.string(), emailed: z.boolean() }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "members:manage");
      const { email, role, tenantId, expiresInDays } = req.body;
      if (!canGrant(access.role!, role)) throw forbidden("You cannot grant this role.");
      if (role === "tenant_admin" && !tenantId)
        throw unprocessable("A tenant admin must be linked to a tenant.");
      await assertTenant(req.params.orgId, tenantId);
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
      const id = await withOrg(db, req.params.orgId, async (tx) => {
        const [inv] = await tx
          .insert(schema.invitations)
          .values({
            orgId: req.params.orgId,
            email: email.toLowerCase(),
            role,
            tenantId: tenantId ?? null,
            tokenHash: sha256(token),
            invitedBy: access.actor.type === "user" ? access.actor.id : null,
            expiresAt,
          })
          .returning({ id: schema.invitations.id });
        await audit(tx, req, access, {
          action: "invitation.create",
          entityType: "invitation",
          entityId: inv!.id,
          data: { email: email.toLowerCase(), role },
        });
        return inv!.id;
      });
      const acceptUrl = `${config.APP_URL.replace(/\/$/, "")}/invite#${token}`;
      let emailed = false;
      if (mailer.enabled) {
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, req.params.orgId));
        const [inviter] =
          access.actor.type === "user"
            ? await db
                .select({ name: schema.users.name })
                .from(schema.users)
                .where(eq(schema.users.id, access.actor.id))
            : [];
        try {
          await mailer.send(
            invitationMessage(
              email.toLowerCase(),
              org?.name ?? "",
              inviter?.name ?? null,
              acceptUrl,
              expiresAt,
            ),
          );
          emailed = true;
        } catch (err) {
          // the link is still returned, so the inviter can deliver it another way
          req.log.error({ err }, "invitation mail failed");
        }
      }
      return reply.status(201).send({ id, acceptUrl, expiresAt: expiresAt.toISOString(), emailed });
    },
  );

  app.delete(
    "/orgs/:orgId/invitations/:invitationId",
    {
      schema: {
        tags: ["organisation"],
        summary: "Withdraw an invitation",
        params: orgParams.extend({ invitationId: uuid }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "members:manage");
      await withOrg(db, req.params.orgId, async (tx) => {
        const gone = await tx
          .delete(schema.invitations)
          .where(
            and(
              eq(schema.invitations.id, req.params.invitationId),
              eq(schema.invitations.orgId, req.params.orgId),
              isNull(schema.invitations.acceptedAt),
            ),
          )
          .returning({ id: schema.invitations.id });
        if (!gone.length) throw notFound("Invitation");
        await audit(tx, req, access, {
          action: "invitation.delete",
          entityType: "invitation",
          entityId: req.params.invitationId,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- API keys ------------------------------------------------------------------------------------------
  const toKey = (r: typeof schema.apiKeys.$inferSelect) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    buildingId: r.buildingId,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    expiresAt: iso(r.expiresAt),
    revokedAt: iso(r.revokedAt),
  });

  app.get(
    "/orgs/:orgId/api-keys",
    {
      schema: {
        tags: ["organisation"],
        summary: "List API keys",
        params: orgParams,
        response: { 200: z.array(apiKey), ...errorResponses },
      },
    },
    async (req) => {
      await requireOrg(db, req, req.params.orgId, "apikeys:manage");
      const rows = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.orgId, req.params.orgId))
        .orderBy(desc(schema.apiKeys.createdAt));
      return rows.map(toKey);
    },
  );

  app.post(
    "/orgs/:orgId/api-keys",
    {
      schema: {
        tags: ["organisation"],
        summary: "Create an API key for a gateway or integration. The key is shown once.",
        params: orgParams,
        body: z.object({
          name: z.string().trim().min(1).max(80),
          scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
          buildingId: uuid.nullable().optional(),
          expiresAt: timestamp.nullable().optional(),
        }),
        response: { 201: apiKey.extend({ key: z.string() }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "apikeys:manage");
      const { name, scopes, buildingId, expiresAt } = req.body;
      if (expiresAt && Date.parse(expiresAt) <= Date.now())
        throw unprocessable("The expiry must be in the future.");
      const generated = newApiKey();
      const row = await withOrg(db, req.params.orgId, async (tx) => {
        if (buildingId) {
          const b = await tx
            .select({ id: schema.buildings.id })
            .from(schema.buildings)
            .where(eq(schema.buildings.id, buildingId));
          if (!b.length) throw unprocessable("Unknown building.");
        }
        const [k] = await tx
          .insert(schema.apiKeys)
          .values({
            orgId: req.params.orgId,
            name,
            prefix: generated.prefix,
            hash: generated.hash,
            scopes: [...new Set(scopes)],
            buildingId: buildingId ?? null,
            createdBy: access.actor.type === "user" ? access.actor.id : null,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
          })
          .returning();
        await audit(tx, req, access, {
          action: "apikey.create",
          entityType: "api_key",
          entityId: k!.id,
          data: { name, scopes, buildingId },
        });
        return k!;
      });
      return reply.status(201).send({ ...toKey(row), key: generated.key });
    },
  );

  app.delete(
    "/orgs/:orgId/api-keys/:keyId",
    {
      schema: {
        tags: ["organisation"],
        summary: "Revoke an API key",
        params: orgParams.extend({ keyId: uuid }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "apikeys:manage");
      await withOrg(db, req.params.orgId, async (tx) => {
        const done = await tx
          .update(schema.apiKeys)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(schema.apiKeys.id, req.params.keyId),
              eq(schema.apiKeys.orgId, req.params.orgId),
              isNull(schema.apiKeys.revokedAt),
            ),
          )
          .returning({ id: schema.apiKeys.id });
        if (!done.length) throw notFound("API key");
        await audit(tx, req, access, {
          action: "apikey.revoke",
          entityType: "api_key",
          entityId: req.params.keyId,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- audit log -----------------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/audit-log",
    {
      schema: {
        tags: ["organisation"],
        summary: "Audit log, newest first",
        params: orgParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.number(),
                at: z.string(),
                actorType: z.string(),
                actorId: z.string().nullable(),
                action: z.string(),
                entityType: z.string(),
                entityId: z.string().nullable(),
                data: z.unknown(),
                ip: z.string().nullable(),
                requestId: z.string().nullable(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      await requireOrg(db, req, req.params.orgId, "audit:read");
      const before = decodeCursor(req.query.cursor)?.[0];
      const rows = await withOrg(db, req.params.orgId, (tx) =>
        tx
          .select()
          .from(schema.auditLog)
          .where(typeof before === "number" ? lt(schema.auditLog.id, before) : undefined)
          .orderBy(desc(schema.auditLog.id))
          .limit(req.query.limit + 1),
      );
      const page = rows.slice(0, req.query.limit);
      return {
        items: page.map((r) => ({ ...r, at: r.at.toISOString(), data: r.data ?? null })),
        nextCursor: rows.length > req.query.limit ? encodeCursor([page[page.length - 1]!.id]) : null,
      };
    },
  );

  // ---- emission factors ----------------------------------------------------------------------------------
  app.get(
    "/orgs/:orgId/emission-factors",
    {
      schema: {
        tags: ["carbon"],
        summary: "Shared and organisation emission factors",
        params: orgParams,
        response: { 200: z.array(factor), ...errorResponses },
      },
    },
    async (req) => {
      await requireOrg(db, req, req.params.orgId, "report:read");
      const rows = await withOrg(db, req.params.orgId, (tx) =>
        tx
          .select()
          .from(schema.emissionFactors)
          .where(or(isNull(schema.emissionFactors.orgId), eq(schema.emissionFactors.orgId, req.params.orgId)))
          .orderBy(schema.emissionFactors.region, desc(schema.emissionFactors.year)),
      );
      return rows.map((r) => ({
        id: r.id,
        shared: r.orgId === null,
        region: r.region,
        year: r.year,
        method: r.method,
        kgPerKwh: r.kgPerKwh,
        source: r.source,
        status: r.status,
      }));
    },
  );

  app.post(
    "/orgs/:orgId/emission-factors",
    {
      schema: {
        tags: ["carbon"],
        summary:
          "Add or replace an organisation-specific emission factor (takes precedence over the shared library)",
        params: orgParams,
        body: z.object({
          region: z.string().regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,16}){0,3}$/),
          year: z.number().int().min(2000).max(2100),
          method: z.enum(["location", "market"]),
          kgPerKwh: z.number().min(0).max(2),
          source: z.string().trim().min(5).max(500),
          status: z.enum(["verified", "to_verify"]).default("to_verify"),
        }),
        response: { 201: factor, ...errorResponses },
      },
    },
    async (req, reply) => {
      const access = await requireOrg(db, req, req.params.orgId, "factor:write");
      const row = await withOrg(db, req.params.orgId, async (tx) => {
        const [f] = await tx
          .insert(schema.emissionFactors)
          .values({ ...req.body, orgId: req.params.orgId })
          .onConflictDoUpdate({
            target: [
              schema.emissionFactors.orgId,
              schema.emissionFactors.region,
              schema.emissionFactors.year,
              schema.emissionFactors.method,
            ],
            set: { kgPerKwh: req.body.kgPerKwh, source: req.body.source, status: req.body.status },
          })
          .returning();
        await audit(tx, req, access, {
          action: "factor.upsert",
          entityType: "emission_factor",
          entityId: f!.id,
          data: req.body,
        });
        return f!;
      });
      return reply.status(201).send({
        id: row.id,
        shared: false,
        region: row.region,
        year: row.year,
        method: row.method,
        kgPerKwh: row.kgPerKwh,
        source: row.source,
        status: row.status,
      });
    },
  );
};
