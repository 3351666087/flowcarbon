import { type Db, schema } from "@flowcarbon/db";
import { looksLikeApiKey, sha256 } from "@flowcarbon/security";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config";
import { forbidden, unauthorized } from "../errors";
import { cookieName, resolveSession, type SessionUser } from "./sessions";

export type Principal =
  | ({ kind: "user" } & SessionUser)
  | {
      kind: "api_key";
      apiKeyId: string;
      orgId: string;
      scopes: string[];
      buildingId: string | null;
      name: string;
    };

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_TOUCH_EVERY_MS = 60_000;

async function resolveApiKey(db: Db, key: string): Promise<Principal | null> {
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.hash, sha256(key)),
        isNull(schema.apiKeys.revokedAt),
        or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, new Date())),
      ),
    );
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > KEY_TOUCH_EVERY_MS)
    await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id));
  return {
    kind: "api_key",
    apiKeyId: row.id,
    orgId: row.orgId,
    scopes: row.scopes,
    buildingId: row.buildingId,
    name: row.name,
  };
}

/**
 * Resolves the caller from `Authorization: Bearer <api key>` or the session cookie. Cookie-authenticated
 * unsafe requests must come from an allowed Origin (CSRF defence in addition to SameSite=Lax).
 */
export const principalPlugin = fp(async (app: FastifyInstance, opts: { db: Db; config: Config }) => {
  const { db, config } = opts;
  const allowed = new Set(config.CORS_ORIGINS);
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const key = auth.slice(7).trim();
      if (!looksLikeApiKey(key)) throw unauthorized("Invalid API key.");
      req.principal = await resolveApiKey(db, key);
      if (!req.principal) throw unauthorized("Invalid, expired or revoked API key.");
      return;
    }
    const token = req.cookies[cookieName(config)];
    if (!token) return;
    const user = await resolveSession(db, config, token);
    if (!user) return;
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const sameHost = origin && host && (origin === `http://${host}` || origin === `https://${host}`);
      if (!origin || !(allowed.has(origin) || sameHost)) throw forbidden("Cross-site request blocked.");
    }
    req.principal = { kind: "user", ...user };
  });
});

export function requireUser(req: FastifyRequest): Extract<Principal, { kind: "user" }> {
  if (req.principal?.kind !== "user") throw unauthorized();
  return req.principal;
}
