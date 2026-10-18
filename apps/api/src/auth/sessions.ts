import { type Db, schema } from "@flowcarbon/db";
import { randomToken, sha256 } from "@flowcarbon/security";
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config";

export const SESSION_COOKIE = "fc_session";
/** with Secure cookies the __Host- prefix pins the cookie to this host and path / */
export const cookieName = (config: Config) =>
  config.COOKIE_SECURE ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;

const TOUCH_EVERY_MS = 5 * 60_000;

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  locale: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  persistent: boolean;
}

/**
 * How long a session lives without use, and at most. A session the user asked to keep ("keep me signed in", and
 * always in the Android app) lasts weeks; any other ends with the browser session or after hours of inactivity.
 */
function lifetime(config: Config, persistent: boolean) {
  return persistent
    ? {
        idleMs: config.SESSION_REMEMBER_DAYS * 86_400_000,
        maxMs: config.SESSION_REMEMBER_MAX_DAYS * 86_400_000,
      }
    : { idleMs: config.SESSION_IDLE_HOURS * 3_600_000, maxMs: config.SESSION_MAX_DAYS * 86_400_000 };
}

export async function createSession(
  db: Db,
  config: Config,
  userId: string,
  req: FastifyRequest,
  persistent = false,
): Promise<IssuedSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + lifetime(config, persistent).idleMs);
  await db.insert(schema.sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    persistent,
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
  });
  // opportunistic clean-up of this user's expired sessions
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, new Date())));
  return { token, expiresAt, persistent };
}

/** A kept session's cookie expires with the session; any other is a browser-session cookie. */
export function setSessionCookie(reply: FastifyReply, config: Config, session: IssuedSession) {
  reply.setCookie(cookieName(config), session.token, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    expires: session.persistent ? session.expiresAt : undefined,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(cookieName(config), {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
  });
}

/**
 * Resolves a session token. Sessions slide: each use (at most every 5 min) extends the idle expiry, up to the
 * absolute limit after sign-in. `renewed` carries the new expiry when it moved, so a kept session's cookie can
 * move with it.
 */
export async function resolveSession(
  db: Db,
  config: Config,
  token: string,
): Promise<{ user: SessionUser; renewed: IssuedSession | null } | null> {
  const id = sha256(token);
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      persistent: schema.sessions.persistent,
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      locale: schema.users.locale,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now), isNull(schema.users.disabledAt)),
    );
  if (!row) return null;
  const { idleMs, maxMs } = lifetime(config, row.persistent);
  const maxAt = row.createdAt.getTime() + maxMs;
  if (now.getTime() > maxAt) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  let renewed: IssuedSession | null = null;
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    const expiresAt = new Date(Math.min(maxAt, now.getTime() + idleMs));
    await db.update(schema.sessions).set({ lastSeenAt: now, expiresAt }).where(eq(schema.sessions.id, id));
    renewed = { token, expiresAt, persistent: row.persistent };
  }
  return {
    user: {
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      name: row.name,
      locale: row.locale,
    },
    renewed,
  };
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** Signs a user out everywhere except, optionally, the current session (after a password change). */
export async function revokeOtherSessions(db: Db, userId: string, keepSessionId?: string) {
  await db
    .delete(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, userId),
        keepSessionId ? ne(schema.sessions.id, keepSessionId) : undefined,
      ),
    );
}
