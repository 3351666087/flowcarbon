import { schema } from "@flowcarbon/db";
import {
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  passwordProblems,
  sha256,
  verifyPassword,
} from "@flowcarbon/security";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { requireUser } from "../auth/principal";
import {
  clearSessionCookie,
  createSession,
  revokeOtherSessions,
  revokeSession,
  setSessionCookie,
} from "../auth/sessions";
import { HttpError, unauthorized, unprocessable } from "../errors";
import { errorResponses, roleSchema, uuid } from "../schemas";

const membership = z.object({
  orgId: uuid,
  orgSlug: z.string(),
  orgName: z.string(),
  role: roleSchema,
  tenantId: uuid.nullable(),
});
const me = z.object({
  user: z.object({ id: uuid, email: z.string(), name: z.string(), locale: z.string() }),
  memberships: z.array(membership),
});

export const authRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, config }) => {
  async function loadMe(userId: string) {
    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        locale: schema.users.locale,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const memberships = await db
      .select({
        orgId: schema.organizations.id,
        orgSlug: schema.organizations.slug,
        orgName: schema.organizations.name,
        role: schema.memberships.role,
        tenantId: schema.memberships.tenantId,
      })
      .from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
      .where(eq(schema.memberships.userId, userId))
      .orderBy(schema.organizations.name);
    return { user: user!, memberships };
  }

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: config.LOGIN_ATTEMPTS_PER_15_MIN,
          timeWindow: "15 minutes",
          keyGenerator: (req) => `${req.ip}|login`,
        },
      },
      schema: {
        tags: ["auth"],
        summary: "Sign in with email and password; sets the session cookie",
        body: z.object({ email: z.email().max(320), password: z.string().min(1).max(256) }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const [user] = await db
        .select({
          id: schema.users.id,
          passwordHash: schema.users.passwordHash,
          disabledAt: schema.users.disabledAt,
        })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${email}`);
      // verify against a dummy hash when the account does not exist, so timing does not reveal registered emails
      const ok = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), req.body.password);
      if (!user?.passwordHash || !ok || user.disabledAt) {
        req.log.info({ email: sha256(email).slice(0, 12) }, "failed sign-in");
        throw unauthorized("Email or password is incorrect.");
      }
      if (needsRehash(user.passwordHash))
        await db
          .update(schema.users)
          .set({ passwordHash: await hashPassword(req.body.password) })
          .where(eq(schema.users.id, user.id));
      const { token, expiresAt } = await createSession(db, config, user.id, req);
      setSessionCookie(reply, config, token, expiresAt);
      return loadMe(user.id);
    },
  );

  app.post(
    "/auth/logout",
    { schema: { tags: ["auth"], summary: "Sign out of this session", response: { 204: z.null() } } },
    async (req, reply) => {
      if (req.principal?.kind === "user") await revokeSession(db, req.principal.sessionId);
      clearSessionCookie(reply, config);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/me",
    {
      schema: {
        tags: ["auth"],
        summary: "The signed-in user and their organisations",
        response: { 200: me, ...errorResponses },
      },
    },
    async (req) => loadMe(requireUser(req).userId),
  );

  app.patch(
    "/me",
    {
      schema: {
        tags: ["auth"],
        summary:
          "Update the signed-in user's name or language (AI explanations are written in this language)",
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          locale: z.enum(["en", "zh"]).optional(),
        }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req) => {
      const u = requireUser(req);
      if (req.body.name !== undefined || req.body.locale !== undefined)
        await db
          .update(schema.users)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(schema.users.id, u.userId));
      return loadMe(u.userId);
    },
  );

  app.post(
    "/me/password",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        tags: ["auth"],
        summary: "Change password; signs out every other session",
        body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().max(256) }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const [row] = await db
        .select({ hash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, u.userId));
      if (!row?.hash || !(await verifyPassword(row.hash, req.body.currentPassword)))
        throw new HttpError(403, "The current password is incorrect.", "forbidden");
      const problems = passwordProblems(req.body.newPassword, { email: u.email });
      if (problems.length) throw unprocessable("The new password is not acceptable.", problems);
      await db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() })
        .where(eq(schema.users.id, u.userId));
      await revokeOtherSessions(db, u.userId, u.sessionId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/auth/invitations/accept",
    {
      config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
      schema: {
        tags: ["auth"],
        summary: "Accept an invitation: creates the account if needed, adds the membership and signs in",
        body: z.object({
          token: z.string().min(20).max(200),
          name: z.string().trim().min(1).max(120),
          password: z.string().max(256),
        }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      const { token, name, password } = req.body;
      const userId = await db.transaction(async (tx) => {
        const [inv] = await tx
          .select()
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.tokenHash, sha256(token)),
              isNull(schema.invitations.acceptedAt),
              gt(schema.invitations.expiresAt, new Date()),
            ),
          )
          .for("update");
        if (!inv)
          throw new HttpError(404, "This invitation is invalid, expired or already used.", "not_found");
        const email = inv.email.toLowerCase();
        let [user] = await tx.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
        if (user) {
          // an existing account must prove it is the same person
          if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password)))
            throw new HttpError(
              403,
              "An account with this email exists; enter its password to accept.",
              "forbidden",
            );
        } else {
          const problems = passwordProblems(password, { email });
          if (problems.length) throw unprocessable("The password is not acceptable.", problems);
          [user] = await tx
            .insert(schema.users)
            .values({ email, name, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() })
            .returning();
        }
        await tx
          .insert(schema.memberships)
          .values({ orgId: inv.orgId, userId: user!.id, role: inv.role, tenantId: inv.tenantId })
          .onConflictDoUpdate({
            target: [schema.memberships.orgId, schema.memberships.userId],
            set: { role: inv.role, tenantId: inv.tenantId },
          });
        await tx
          .update(schema.invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(schema.invitations.id, inv.id));
        await tx.execute(sql`select set_config('app.org_id', ${inv.orgId}, true)`);
        await tx.insert(schema.auditLog).values({
          orgId: inv.orgId,
          actorType: "user",
          actorId: user!.id,
          action: "invitation.accept",
          entityType: "membership",
          entityId: user!.id,
          data: { role: inv.role },
          ip: req.ip,
          requestId: String(req.id),
        });
        return user!.id;
      });
      const { token: session, expiresAt } = await createSession(db, config, userId, req);
      setSessionCookie(reply, config, session, expiresAt);
      return loadMe(userId);
    },
  );
};
