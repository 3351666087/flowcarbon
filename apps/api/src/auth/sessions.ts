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

export async function createSession(
  db: Db,
  config: Config,
  userId: string,
  req: FastifyRequest,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.SESSION_IDLE_HOURS * 3_600_000);
  await db.insert(schema.sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
  });
  // opportunistic clean-up of this user's expired sessions
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, new Date())));
  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(cookieName(config), token, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    expires: expiresAt,
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
 * Resolves a session token. Sessions slide: each use (at most every 5 min) extends the idle expiry, up to
 * SESSION_MAX_DAYS after sign-in.
 */
export async function resolveSession(db: Db, config: Config, token: string): Promise<SessionUser | null> {
  const id = sha256(token);
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
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
  const maxAt = row.createdAt.getTime() + config.SESSION_MAX_DAYS * 86_400_000;
  if (now.getTime() > maxAt) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    const expiresAt = new Date(Math.min(maxAt, now.getTime() + config.SESSION_IDLE_HOURS * 3_600_000));
    await db.update(schema.sessions).set({ lastSeenAt: now, expiresAt }).where(eq(schema.sessions.id, id));
  }
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    locale: row.locale,
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
