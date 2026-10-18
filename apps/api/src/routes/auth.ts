import { randomInt } from "node:crypto";
import { schema } from "@flowcarbon/db";
import {
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  passwordProblems,
  safeEqual,
  sha256,
  verifyPassword,
} from "@flowcarbon/security";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
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
import { codeMessage } from "../mail";
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

/** one-time email codes: six digits, ten minutes, five attempts; a new one at most every 45 s */
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODE_RESEND_MS = 45_000;
const codePurpose = z.enum(["sign_in", "password_reset"]);
const sixDigits = z.string().regex(/^\d{6}$/, "Six digits.");

export const authRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, config, mailer }) => {
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
        body: z.object({
          email: z.email().max(320),
          password: z.string().min(1).max(256),
          remember: z
            .boolean()
            .default(false)
            .describe(
              "Keep me signed in: the session lasts weeks and its cookie outlives the browser session",
            ),
        }),
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
      setSessionCookie(reply, config, await createSession(db, config, user.id, req, req.body.remember));
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

  // ---- email codes: sign in without a password, or reset it ---------------------------------------------------
  const codeHash = (userId: string, code: string) => sha256(`${userId}:${code}`);
  const wrongCode = () => unauthorized("The code is wrong or has expired.");

  /** Checks a code and consumes it; returns the user. Each try counts, before the comparison, so parallel guesses
   * cannot exceed the limit. */
  async function consumeCode(email: string, purpose: z.infer<typeof codePurpose>, code: string) {
    const [row] = await db
      .select({
        id: schema.emailCodes.id,
        userId: schema.emailCodes.userId,
        codeHash: schema.emailCodes.codeHash,
        disabledAt: schema.users.disabledAt,
      })
      .from(schema.emailCodes)
      .innerJoin(schema.users, eq(schema.users.id, schema.emailCodes.userId))
      .where(
        and(
          sql`lower(${schema.users.email}) = ${email}`,
          eq(schema.emailCodes.purpose, purpose),
          isNull(schema.emailCodes.consumedAt),
          gt(schema.emailCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.emailCodes.createdAt))
      .limit(1);
    if (!row || row.disabledAt) throw wrongCode();
    const [counted] = await db
      .update(schema.emailCodes)
      .set({ attempts: sql`${schema.emailCodes.attempts} + 1` })
      .where(and(eq(schema.emailCodes.id, row.id), lt(schema.emailCodes.attempts, CODE_ATTEMPTS)))
      .returning({ id: schema.emailCodes.id });
    if (!counted || !safeEqual(row.codeHash, codeHash(row.userId, code))) throw wrongCode();
    const [used] = await db
      .update(schema.emailCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(schema.emailCodes.id, row.id), isNull(schema.emailCodes.consumedAt)))
      .returning({ id: schema.emailCodes.id });
    if (!used) throw wrongCode();
    // receiving the code proves the address
    await db
      .update(schema.users)
      .set({ emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())` })
      .where(eq(schema.users.id, row.userId));
    return row.userId;
  }

  app.get(
    "/auth/methods",
    {
      schema: {
        tags: ["auth"],
        summary: "How people can sign in here: email codes need outgoing mail to be configured",
        response: { 200: z.object({ password: z.boolean(), emailCode: z.boolean() }) },
      },
    },
    async () => ({ password: true, emailCode: mailer.enabled }),
  );

  app.post(
    "/auth/code",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code` },
      },
      schema: {
        tags: ["auth"],
        summary:
          "Email a one-time code for signing in or resetting the password. Always 202, whether or not the address has an account.",
        body: z.object({ email: z.email().max(320), purpose: codePurpose }),
        response: { 202: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!mailer.enabled) throw new HttpError(503, "Email is not set up on this server.", "unavailable");
      const email = req.body.email.trim().toLowerCase();
      const { purpose } = req.body;
      const [user] = await db
        .select({ id: schema.users.id, locale: schema.users.locale, disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${email}`);
      if (user && !user.disabledAt) {
        const [recent] = await db
          .select({ createdAt: schema.emailCodes.createdAt })
          .from(schema.emailCodes)
          .where(and(eq(schema.emailCodes.userId, user.id), eq(schema.emailCodes.purpose, purpose)))
          .orderBy(desc(schema.emailCodes.createdAt))
          .limit(1);
        if (!recent || Date.now() - recent.createdAt.getTime() > CODE_RESEND_MS) {
          const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
          await db.transaction(async (tx) => {
            // a new code retires the previous one
            await tx
              .update(schema.emailCodes)
              .set({ consumedAt: new Date() })
              .where(
                and(
                  eq(schema.emailCodes.userId, user.id),
                  eq(schema.emailCodes.purpose, purpose),
                  isNull(schema.emailCodes.consumedAt),
                ),
              );
            await tx.insert(schema.emailCodes).values({
              userId: user.id,
              purpose,
              codeHash: codeHash(user.id, code),
              expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
            });
          });
          // sent in the background, so the answer takes as long whether or not the account exists
          mailer
            .send(codeMessage(purpose, user.locale, email, code, CODE_MINUTES))
            .catch((err) => req.log.error({ err, purpose }, "code mail failed"));
        }
      }
      return reply.status(202).send(null);
    },
  );

  app.post(
    "/auth/code/sign-in",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code-verify` },
      },
      schema: {
        tags: ["auth"],
        summary: "Sign in with an emailed code; sets the session cookie",
        body: z.object({
          email: z.email().max(320),
          code: sixDigits,
          remember: z.boolean().default(false).describe("Keep me signed in, as for sign-in"),
        }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      const userId = await consumeCode(req.body.email.trim().toLowerCase(), "sign_in", req.body.code);
      setSessionCookie(reply, config, await createSession(db, config, userId, req, req.body.remember));
      return loadMe(userId);
    },
  );

  app.post(
    "/auth/password/reset",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code-verify` },
      },
      schema: {
        tags: ["auth"],
        summary: "Choose a new password with an emailed code; signs out every session and signs in here",
        body: z.object({
          email: z.email().max(320),
          code: sixDigits,
          password: z.string().max(256),
          remember: z.boolean().default(false).describe("Keep me signed in, as for sign-in"),
        }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      // the policy is checked first, so an unacceptable password does not use up the code
      const problems = passwordProblems(req.body.password, { email });
      if (problems.length) throw unprocessable("The password is not acceptable.", problems);
      const userId = await consumeCode(email, "password_reset", req.body.code);
      await db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.password), updatedAt: new Date() })
        .where(eq(schema.users.id, userId));
      await revokeOtherSessions(db, userId);
      setSessionCookie(reply, config, await createSession(db, config, userId, req, req.body.remember));
      return loadMe(userId);
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
          remember: z.boolean().default(false).describe("Keep me signed in, as for sign-in"),
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
      setSessionCookie(reply, config, await createSession(db, config, userId, req, req.body.remember));
      return loadMe(userId);
    },
  );
};
