import { randomInt } from "node:crypto";
import { schema } from "@flowcarbon/db";
import {
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  passwordProblems,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from "@flowcarbon/security";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { deviceAccounts, signIn, signOut, switchTo } from "../auth/device";
import { assertSameSite, requireUser } from "../auth/principal";
import { clearSessionCookie, revokeOtherSessions } from "../auth/sessions";
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
  user: z.object({
    id: uuid,
    email: z.string(),
    name: z.string(),
    locale: z.string(),
    hasPassword: z.boolean(),
  }),
  memberships: z.array(membership),
});

/** one-time email codes: six digits, ten minutes, five attempts; a new one at most every 45 s */
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODE_RESEND_MS = 45_000;
const sixDigits = z.string().regex(/^\d{6}$/, "Six digits.");

/** A URL-safe, unique handle for a new organisation: its name in ASCII where it has some, plus a random tail. */
export function slugFor(name: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${
    randomToken(4)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 5) || "x"
  }`;
}

export const authRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db, config, mailer }) => {
  const allowed = new Set(config.CORS_ORIGINS);
  async function loadMe(userId: string) {
    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        locale: schema.users.locale,
        hasPassword: sql<boolean>`${schema.users.passwordHash} is not null`,
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
      await signIn(db, config, req, reply, user.id, req.body.remember);
      return loadMe(user.id);
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary:
          "Sign out the active account (the next account on this device takes over, if any), or every account on it",
        body: z.object({ everyone: z.boolean().default(false) }).nullish(),
        response: {
          200: z.object({ next: z.object({ userId: uuid, name: z.string(), email: z.string() }).nullable() }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      assertSameSite(req, allowed);
      const next = await signOut(db, config, req, reply, req.body?.everyone ?? false);
      if (!next) clearSessionCookie(reply, config);
      return { next: next && { userId: next.userId, name: next.name, email: next.email } };
    },
  );

  // ---- email: one way in for new and returning people, and password resets --------------------------------------
  //
  // The address is the identity. "Continue with email" sends a six-digit code; proving the address either signs the
  // person in or, for an address without an account, hands back a short-lived sign-up ticket. The answer to "send me
  // a code" is the same whether or not an account exists, so the form cannot be used to find out who has one.

  const codeHash = (email: string, purpose: string, code: string) => sha256(`${purpose}:${email}:${code}`);
  const wrongCode = () => unauthorized("The code is wrong or has expired.");
  const normalise = (email: string) => email.trim().toLowerCase();

  async function userByEmail(email: string) {
    const [user] = await db
      .select({ id: schema.users.id, locale: schema.users.locale, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`);
    return user && !user.disabledAt ? user : null;
  }

  /** Issues and mails a code, at most one per address and purpose every 45 s; a new code retires the last. */
  async function sendCode(
    req: FastifyRequest,
    email: string,
    purpose: "continue" | "password_reset",
    userId: string | null,
    locale: string,
  ) {
    const [recent] = await db
      .select({ createdAt: schema.emailCodes.createdAt })
      .from(schema.emailCodes)
      .where(and(eq(schema.emailCodes.email, email), eq(schema.emailCodes.purpose, purpose)))
      .orderBy(desc(schema.emailCodes.createdAt))
      .limit(1);
    if (recent && Date.now() - recent.createdAt.getTime() < CODE_RESEND_MS) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.emailCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(schema.emailCodes.email, email),
            eq(schema.emailCodes.purpose, purpose),
            isNull(schema.emailCodes.consumedAt),
          ),
        );
      await tx.insert(schema.emailCodes).values({
        userId,
        email,
        purpose,
        codeHash: codeHash(email, purpose, code),
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      });
    });
    // sent in the background, so the answer takes as long whether or not the account exists
    mailer
      .send(codeMessage(purpose, locale, email, code, CODE_MINUTES))
      .catch((err) => req.log.error({ err, purpose }, "code mail failed"));
  }

  /** Checks a code and consumes it. Each try counts before the comparison, so parallel guesses cannot exceed the
   * limit. Receiving the code proves the address. */
  async function consumeCode(email: string, purpose: string, code: string) {
    const [row] = await db
      .select({ id: schema.emailCodes.id, codeHash: schema.emailCodes.codeHash })
      .from(schema.emailCodes)
      .where(
        and(
          eq(schema.emailCodes.email, email),
          eq(schema.emailCodes.purpose, purpose),
          isNull(schema.emailCodes.consumedAt),
          gt(schema.emailCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.emailCodes.createdAt))
      .limit(1);
    if (!row) throw wrongCode();
    const [counted] = await db
      .update(schema.emailCodes)
      .set({ attempts: sql`${schema.emailCodes.attempts} + 1` })
      .where(and(eq(schema.emailCodes.id, row.id), lt(schema.emailCodes.attempts, CODE_ATTEMPTS)))
      .returning({ id: schema.emailCodes.id });
    if (!counted || !safeEqual(row.codeHash, codeHash(email, purpose, code))) throw wrongCode();
    const [used] = await db
      .update(schema.emailCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(schema.emailCodes.id, row.id), isNull(schema.emailCodes.consumedAt)))
      .returning({ id: schema.emailCodes.id });
    if (!used) throw wrongCode();
    await db
      .update(schema.users)
      .set({ emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())` })
      .where(sql`lower(${schema.users.email}) = ${email}`);
  }

  const signUpOpen = () => config.SIGNUP_OPEN && mailer.enabled;
  async function demoOrg() {
    if (!config.DEMO_ORG_SLUG) return null;
    const [org] = await db
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, config.DEMO_ORG_SLUG));
    return org ?? null;
  }

  app.get(
    "/auth/methods",
    {
      schema: {
        tags: ["auth"],
        summary:
          "How people get in here: email codes need outgoing mail; sign-up needs SIGNUP_OPEN; demo is the organisation new accounts may explore",
        response: {
          200: z.object({
            password: z.boolean(),
            emailCode: z.boolean(),
            signUp: z.boolean(),
            demo: z.object({ name: z.string(), slug: z.string() }).nullable(),
          }),
        },
      },
    },
    async () => {
      const demo = await demoOrg();
      return {
        password: true,
        emailCode: mailer.enabled,
        signUp: signUpOpen(),
        demo: demo && { name: demo.name, slug: demo.slug },
      };
    },
  );

  app.post(
    "/auth/identify",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|identify` },
      },
      schema: {
        tags: ["auth"],
        summary:
          "Identifier first, as large suites sign in: is there an account for this address, and does it have a password? Rate-limited.",
        body: z.object({ email: z.email().max(320) }),
        response: {
          200: z.object({ account: z.enum(["password", "no_password", "none"]), signUp: z.boolean() }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const email = normalise(req.body.email);
      const [user] = await db
        .select({ hasPassword: sql<boolean>`${schema.users.passwordHash} is not null` })
        .from(schema.users)
        .where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.disabledAt)));
      return {
        account: !user
          ? ("none" as const)
          : user.hasPassword
            ? ("password" as const)
            : ("no_password" as const),
        signUp: signUpOpen(),
      };
    },
  );

  app.post(
    "/auth/email/start",
    {
      config: {
        rateLimit: { max: 8, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code` },
      },
      schema: {
        tags: ["auth"],
        summary:
          "Sign-up, step 1: email a six-digit code to a new address to prove it is yours. Always 202; addresses that already have an account get nothing.",
        body: z.object({
          email: z.email().max(320),
          locale: z.enum(["en", "zh"]).default("en").describe("Language of the email"),
        }),
        response: { 202: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!mailer.enabled) throw new HttpError(503, "Email is not set up on this server.", "unavailable");
      const email = normalise(req.body.email);
      if (signUpOpen() && !(await userByEmail(email)))
        await sendCode(req, email, "continue", null, req.body.locale);
      return reply.status(202).send(null);
    },
  );

  app.post(
    "/auth/email/verify",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code-verify` },
      },
      schema: {
        tags: ["auth"],
        summary:
          "Sign-up, step 2: the code proves the address and returns a 30-minute ticket for creating the account",
        body: z.object({ email: z.email().max(320), code: sixDigits }),
        response: { 200: z.object({ ticket: z.string() }), ...errorResponses },
      },
    },
    async (req) => {
      const email = normalise(req.body.email);
      await consumeCode(email, "continue", req.body.code);
      if (await userByEmail(email))
        throw new HttpError(409, "This address already has an account. Sign in instead.", "conflict");
      if (!signUpOpen()) throw wrongCode();
      const ticket = randomToken(24);
      await db.insert(schema.emailCodes).values({
        email,
        purpose: "signup_ticket",
        codeHash: sha256(ticket),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      return { ticket };
    },
  );

  app.post(
    "/auth/signup",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        tags: ["auth"],
        summary:
          "Sign-up, step 3: create the account for a verified address with a password, then join the demo organisation read-only or found one",
        body: z.object({
          ticket: z.string().min(20).max(100),
          name: z.string().trim().min(1).max(120),
          password: z.string().max(256),
          start: z.enum(["demo", "organisation"]),
          organisation: z.string().trim().min(2).max(120).optional(),
          locale: z.enum(["en", "zh"]).default("en"),
          remember: z.boolean().default(false).describe("Keep me signed in, as for sign-in"),
        }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!signUpOpen()) throw new HttpError(403, "This server does not take new accounts.", "forbidden");
      const { ticket, name, password, start, organisation, locale } = req.body;
      if (start === "organisation" && !organisation) throw unprocessable("Name the organisation.");
      // the password rules are checked before the ticket is spent
      const [pending] = await db
        .select({ email: schema.emailCodes.email })
        .from(schema.emailCodes)
        .where(
          and(eq(schema.emailCodes.codeHash, sha256(ticket)), eq(schema.emailCodes.purpose, "signup_ticket")),
        );
      const problems = passwordProblems(password, { email: pending?.email });
      if (problems.length) throw unprocessable("The password is not acceptable.", problems);
      const passwordHash = await hashPassword(password);
      const demo = start === "demo" ? await demoOrg() : null;
      if (start === "demo" && !demo) throw unprocessable("There is no demo organisation to join.");
      const userId = await db.transaction(async (tx) => {
        const [t] = await tx
          .update(schema.emailCodes)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(schema.emailCodes.codeHash, sha256(ticket)),
              eq(schema.emailCodes.purpose, "signup_ticket"),
              isNull(schema.emailCodes.consumedAt),
              gt(schema.emailCodes.expiresAt, new Date()),
            ),
          )
          .returning({ email: schema.emailCodes.email });
        if (!t) throw new HttpError(410, "This sign-up has expired. Start again with your email.", "gone");
        const [taken] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = ${t.email}`);
        if (taken)
          throw new HttpError(409, "This address already has an account. Sign in instead.", "conflict");
        const [user] = await tx
          .insert(schema.users)
          .values({ email: t.email, name, locale, passwordHash, emailVerifiedAt: new Date() })
          .returning({ id: schema.users.id });
        const orgId = demo
          ? demo.id
          : (
              await tx
                .insert(schema.organizations)
                .values({ name: organisation!, slug: slugFor(organisation!) })
                .returning({ id: schema.organizations.id })
            )[0]!.id;
        await tx
          .insert(schema.memberships)
          .values({ orgId, userId: user!.id, role: demo ? "viewer" : "owner" });
        await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
        await tx.insert(schema.auditLog).values({
          orgId,
          actorType: "user",
          actorId: user!.id,
          action: demo ? "member.join_demo" : "organisation.create",
          entityType: demo ? "membership" : "organisation",
          entityId: demo ? user!.id : orgId,
          data: { via: "signup" },
          ip: req.ip,
          requestId: String(req.id),
        });
        return user!.id;
      });
      await signIn(db, config, req, reply, userId, req.body.remember);
      return loadMe(userId);
    },
  );

  // ---- accounts on this device ---------------------------------------------------------------------------------

  const account = z.object({ userId: uuid, name: z.string(), email: z.string(), active: z.boolean() });

  app.get(
    "/auth/accounts",
    {
      schema: {
        tags: ["auth"],
        summary: "Accounts signed in on this device, the active one first, for an account chooser",
        response: { 200: z.object({ accounts: z.array(account) }) },
      },
    },
    async (_req, reply) => {
      const { active, others } = await deviceAccounts(db, config, _req);
      reply.header("cache-control", "no-store");
      return {
        accounts: [
          ...(active ? [{ ...active, active: true }] : []),
          ...others.map((s) => ({ ...s, active: false })),
        ].map(({ userId, name, email, active: a }) => ({ userId, name, email, active: a })),
      };
    },
  );

  app.post(
    "/auth/accounts/switch",
    {
      schema: {
        tags: ["auth"],
        summary: "Make another account signed in on this device the active one",
        body: z.object({ userId: uuid }),
        response: { 200: me, ...errorResponses },
      },
    },
    async (req, reply) => {
      assertSameSite(req, allowed);
      const target = await switchTo(db, config, req, reply, req.body.userId);
      if (!target) throw new HttpError(404, "That account is not signed in on this device.", "not_found");
      return loadMe(target.userId);
    },
  );

  app.post(
    "/auth/password/forgot",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes", keyGenerator: (req) => `${req.ip}|code` },
      },
      schema: {
        tags: ["auth"],
        summary:
          "Email a code for choosing a new password. Always 202, whether or not the address has an account.",
        body: z.object({ email: z.email().max(320) }),
        response: { 202: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!mailer.enabled) throw new HttpError(503, "Email is not set up on this server.", "unavailable");
      const email = normalise(req.body.email);
      const user = await userByEmail(email);
      if (user) await sendCode(req, email, "password_reset", user.id, user.locale);
      return reply.status(202).send(null);
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
      const email = normalise(req.body.email);
      // the policy is checked first, so an unacceptable password does not use up the code
      const problems = passwordProblems(req.body.password, { email });
      if (problems.length) throw unprocessable("The password is not acceptable.", problems);
      await consumeCode(email, "password_reset", req.body.code);
      const user = await userByEmail(email);
      if (!user) throw wrongCode();
      await db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.password), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await revokeOtherSessions(db, user.id);
      await signIn(db, config, req, reply, user.id, req.body.remember);
      return loadMe(user.id);
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
        summary:
          "Set or change the password; signs out every other session. People who joined by email code set one without a current password.",
        body: z.object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().max(256) }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const [row] = await db
        .select({ hash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, u.userId));
      if (row?.hash && !(await verifyPassword(row.hash, req.body.currentPassword ?? "")))
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
      await signIn(db, config, req, reply, userId, req.body.remember);
      return loadMe(userId);
    },
  );
};
