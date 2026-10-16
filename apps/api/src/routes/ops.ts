import { safeEqual } from "@flowcarbon/security";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { forbidden } from "../errors";

export const opsRoutes: FastifyPluginAsyncZod<RouteDeps & { version: string }> = async (
  app,
  { db, config, metrics, version },
) => {
  app.get(
    "/healthz",
    {
      config: { rateLimit: false },
      schema: { hide: true, response: { 200: z.object({ status: z.literal("ok"), version: z.string() }) } },
    },
    async () => ({ status: "ok" as const, version }),
  );

  app.get(
    "/readyz",
    {
      config: { rateLimit: false },
      schema: {
        hide: true,
        response: {
          200: z.object({ status: z.literal("ready") }),
          503: z.object({ status: z.literal("unavailable"), reason: z.string() }),
        },
      },
    },
    async (req, reply) => {
      try {
        await db.execute(sql`select 1`);
        return { status: "ready" as const };
      } catch (err) {
        req.log.warn({ err }, "readiness check failed");
        return reply.status(503).send({ status: "unavailable" as const, reason: "database" });
      }
    },
  );

  app.get("/metrics", { config: { rateLimit: false }, schema: { hide: true } }, async (req, reply) => {
    if (config.METRICS_TOKEN) {
      const presented = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!safeEqual(presented, config.METRICS_TOKEN)) throw forbidden();
    } else if (!config.METRICS_PUBLIC) throw forbidden();
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
};
