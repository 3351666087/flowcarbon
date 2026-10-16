import type { FastifyInstance } from "fastify";
import { Counter, collectDefaultMetrics, Histogram, Registry } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "flowcarbon_api_" });
  const duration = new Histogram({
    name: "flowcarbon_api_http_request_duration_seconds",
    help: "HTTP request duration by route and status",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const ingested = new Counter({
    name: "flowcarbon_api_telemetry_items_total",
    help: "Telemetry items accepted, by kind",
    labelNames: ["kind"] as const,
    registers: [registry],
  });
  return { registry, duration, ingested };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function instrument(app: FastifyInstance, metrics: Metrics) {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    metrics.duration.observe(
      { method: req.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });
}
