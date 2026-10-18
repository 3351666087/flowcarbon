import { type Db, schema } from "@flowcarbon/db";
import { sha256 } from "@flowcarbon/security";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config";
import { cookieName, createSession, type IssuedSession, setSessionCookie } from "./sessions";

/**
 * Accounts signed in on this device, the way large suites keep them: one active session (the session cookie) and up
 * to four more in a second HttpOnly cookie, so a person with a work and a client account switches without signing
 * in again. Only kept sessions ("keep me signed in") stay on the device when another account takes over; a session
 * that was meant to end with the browser is signed out instead.
 */
const JAR_COOKIE = "fc_accounts";
const JAR_MAX = 4;
const TOKEN = /^[\w-]{20,100}$/;

const jarName = (config: Config) => (config.COOKIE_SECURE ? `__Host-${JAR_COOKIE}` : JAR_COOKIE);

export interface DeviceSession extends IssuedSession {
  userId: string;
  name: string;
  email: string;
}

function readJar(req: FastifyRequest, config: Config): string[] {
  const raw = req.cookies[jarName(config)];
  return raw
    ? raw
        .split(".")
        .filter((t) => TOKEN.test(t))
        .slice(0, JAR_MAX)
    : [];
}

function writeJar(reply: FastifyReply, config: Config, tokens: string[]) {
  const options = { path: "/", httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "lax" as const };
  if (tokens.length) reply.setCookie(jarName(config), tokens.join("."), { ...options, maxAge: 90 * 86_400 });
  else reply.clearCookie(jarName(config), options);
}

/** The sessions behind these tokens that still work, in the order given, one per person. */
async function resolve(db: Db, tokens: string[]): Promise<DeviceSession[]> {
  const unique = [...new Set(tokens.filter((t) => TOKEN.test(t)))];
  if (!unique.length) return [];
  const byId = new Map(unique.map((t) => [sha256(t), t]));
  const rows = await db
    .select({
      id: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      persistent: schema.sessions.persistent,
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        inArray(schema.sessions.id, [...byId.keys()]),
        gt(schema.sessions.expiresAt, new Date()),
        isNull(schema.users.disabledAt),
      ),
    );
  const found = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: DeviceSession[] = [];
  for (const [id, token] of byId) {
    const r = found.get(id);
    if (!r || seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push({
      token,
      expiresAt: r.expiresAt,
      persistent: r.persistent,
      userId: r.userId,
      name: r.name,
      email: r.email,
    });
  }
  return out;
}

async function revoke(db: Db, tokens: string[]) {
  if (tokens.length) await db.delete(schema.sessions).where(inArray(schema.sessions.id, tokens.map(sha256)));
}

/** Everyone signed in on this device; the active session first when it still works. */
export async function deviceAccounts(db: Db, config: Config, req: FastifyRequest) {
  const active = req.cookies[cookieName(config)];
  const all = await resolve(db, [...(active ? [active] : []), ...readJar(req, config)]);
  return {
    active: all.find((s) => s.token === active) ?? null,
    others: all.filter((s) => s.token !== active),
  };
}

/**
 * Makes `next` the active session and keeps the other kept sessions on the device. A session that was not kept is
 * signed out when it stops being the active one, and the same person never appears twice.
 */
function arrange(reply: FastifyReply, config: Config, next: IssuedSession, others: DeviceSession[]) {
  setSessionCookie(reply, config, next);
  writeJar(
    reply,
    config,
    others.filter((s) => s.persistent).map((s) => s.token),
  );
}

/** Signs a person in on this device: a new active session, everyone else who was signed in stays available. */
export async function signIn(
  db: Db,
  config: Config,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  remember: boolean,
) {
  const { active, others } = await deviceAccounts(db, config, req);
  const before = [...(active ? [active] : []), ...others];
  const issued = await createSession(db, config, userId, req, remember);
  const stay = before.filter((s) => s.userId !== userId && s.persistent).slice(0, JAR_MAX);
  const leave = before.filter((s) => !stay.includes(s)).map((s) => s.token);
  await revoke(db, leave);
  arrange(reply, config, issued, stay);
}

/** Switches the active account to another one already signed in on this device. */
export async function switchTo(
  db: Db,
  config: Config,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<DeviceSession | null> {
  const { active, others } = await deviceAccounts(db, config, req);
  const target = others.find((s) => s.userId === userId);
  if (!target) return null;
  const rest = [...(active ? [active] : []), ...others.filter((s) => s !== target)];
  await revoke(
    db,
    rest.filter((s) => !s.persistent).map((s) => s.token),
  );
  arrange(reply, config, target, rest);
  return target;
}

/**
 * Signs out the active account, or every account on the device. After a single sign-out the next account on the
 * device becomes active, which is returned.
 */
export async function signOut(
  db: Db,
  config: Config,
  req: FastifyRequest,
  reply: FastifyReply,
  everyone: boolean,
): Promise<DeviceSession | null> {
  const active = req.cookies[cookieName(config)];
  const jar = readJar(req, config);
  if (everyone) {
    await revoke(db, [...(active ? [active] : []), ...jar]);
    writeJar(reply, config, []);
    return null;
  }
  if (active) await revoke(db, [active]);
  const others = await resolve(db, jar);
  const [next, ...rest] = others;
  if (!next) {
    writeJar(reply, config, []);
    return null;
  }
  arrange(reply, config, next, rest);
  return next;
}
