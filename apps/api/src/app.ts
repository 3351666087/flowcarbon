import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Db } from "@flowcarbon/db";
import type { JobQueue } from "@flowcarbon/jobs";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { principalPlugin } from "./auth/principal";
import type { Config } from "./config";
import { registerErrorHandler } from "./errors";
import { createMailer, type Mailer } from "./mail";
import { createMetrics, instrument, type Metrics } from "./metrics";
import { analyticsRoutes } from "./routes/analytics";
import { authRoutes } from "./routes/auth";
import { buildingRoutes } from "./routes/buildings";
import { measureRoutes } from "./routes/measures";
import { opsRoutes } from "./routes/ops";
import { orgRoutes } from "./routes/org";
import { overtimeRoutes } from "./routes/overtime";
import { telemetryRoutes } from "./routes/telemetry";

export const API_VERSION = "0.1.0";
export const API_PREFIX = "/api/v1";

export interface RouteDeps {
  db: Db;
  config: Config;
  jobs: JobQueue;
  metrics: Metrics;
  mailer: Mailer;
}

export interface AppDeps {
  db: Db;
  config: Config;
  jobs: JobQueue;
  /** defaults to SMTP from the configuration */
  mailer?: Mailer;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp({ db, config, jobs, mailer, logger }: AppDeps) {
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    },
    requestIdHeader: false,
    ajv: undefined,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  const metrics = createMetrics();
  instrument(app, metrics);
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  await app.register(helmet, {
    // the API serves JSON; the docs UI needs inline styles and scripts from its own bundle
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-request-id"],
    exposedHeaders: ["x-request-id", "retry-after"],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth?.startsWith("Bearer ") ? `key:${auth.slice(7, 20)}` : `ip:${req.ip}`;
    },
  });

  if (config.DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "FlowCarbon API",
          version: API_VERSION,
          description:
            "Occupancy-driven after-hours energy management for office buildings. Browser clients use the session cookie set by `/auth/login`; gateways and integrations use API keys (`Authorization: Bearer fck_…`). Errors follow RFC 9457 (application/problem+json).",
          license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
        },
        servers: [{ url: "/" }],
        components: {
          securitySchemes: {
            session: { type: "apiKey", in: "cookie", name: "fc_session" },
            apiKey: { type: "http", scheme: "bearer", bearerFormat: "fck_…" },
          },
        },
        security: [{ session: [] }, { apiKey: [] }],
        tags: [
          { name: "auth" },
          { name: "organisation" },
          { name: "portfolio" },
          { name: "telemetry" },
          { name: "analytics" },
          { name: "strategy" },
          { name: "overtime" },
          { name: "carbon" },
        ],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: `${API_PREFIX}/docs` });
  }

  await app.register(principalPlugin, { db, config });
  const deps: RouteDeps = { db, config, jobs, metrics, mailer: mailer ?? createMailer(config, app.log) };
  await app.register(opsRoutes, { ...deps, version: API_VERSION });
  await app.register(
    async (api) => {
      await api.register(authRoutes, deps);
      await api.register(orgRoutes, deps);
      await api.register(buildingRoutes, deps);
      await api.register(telemetryRoutes, deps);
      await api.register(analyticsRoutes, deps);
      await api.register(measureRoutes, deps);
      await api.register(overtimeRoutes, deps);
    },
    { prefix: API_PREFIX },
  );
  return app;
}
