import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createDb, schema, withOrg } from "@flowcarbon/db";
import {
  briefPayload,
  createBoss,
  demoPayload,
  explainPayload,
  PgBossJobQueue,
  QUEUES,
  recomputePayload,
} from "@flowcarbon/jobs";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { Counter, collectDefaultMetrics, Histogram, Registry } from "prom-client";
import { runBrief } from "./brief";
import { loadWorkerConfig } from "./config";
import { runDemoWorkspace } from "./demo";
import { runExplain } from "./explain";
import { runNightly } from "./nightly";
import { markRecomputeFailed, runRecompute } from "./recompute";

const config = loadWorkerConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: "flowcarbon-worker" } });
const { db, close } = createDb(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  applicationName: "flowcarbon-worker",
  statementTimeoutMs: 10 * 60_000,
});
const boss = createBoss(config.DATABASE_URL, {
  worker: true,
  applicationName: "flowcarbon-worker-jobs",
  max: 4,
});
const jobs = new PgBossJobQueue(boss);
const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      maxRetries: 2,
      timeout: 120_000,
      defaultHeaders: config.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID }
        : undefined,
    })
  : null;
if (!anthropic) log.warn("ANTHROPIC_API_KEY is not set: explanation requests will be marked failed");

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "flowcarbon_worker_" });
const outcomes = new Counter({
  name: "flowcarbon_worker_jobs_total",
  help: "Jobs by queue and outcome",
  labelNames: ["queue", "outcome"] as const,
  registers: [registry],
});
const durations = new Histogram({
  name: "flowcarbon_worker_job_duration_seconds",
  help: "Job duration by queue",
  labelNames: ["queue"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [registry],
});

async function timed<T>(queue: string, fn: () => Promise<T>): Promise<T> {
  const end = durations.startTimer({ queue });
  try {
    const r = await fn();
    outcomes.inc({ queue, outcome: "completed" });
    return r;
  } catch (err) {
    outcomes.inc({ queue, outcome: "failed" });
    throw err;
  } finally {
    end();
  }
}

boss.on("error", (err) => log.error({ err }, "job queue error"));
await boss.start();

await boss.work(
  QUEUES.recompute.name,
  { localConcurrency: config.RECOMPUTE_CONCURRENCY, batchSize: 1 },
  async ([job]) => {
    if (!job) return;
    const payload = recomputePayload.parse(job.data);
    const r = await timed("recompute", () => runRecompute(db, payload));
    log.info({ jobId: job.id, ...payload, ...r }, "recompute done");
  },
);

await boss.work(
  QUEUES.explain.name,
  { localConcurrency: config.EXPLAIN_CONCURRENCY, batchSize: 1 },
  async ([job]) => {
    if (!job) return;
    const payload = explainPayload.parse(job.data);
    const r = await timed("explain", () =>
      runExplain(
        {
          db,
          client: anthropic,
          model: config.AI_MODEL,
          effort: config.AI_EFFORT,
          log: (o, m) => log.info(o, m),
        },
        payload,
      ),
    );
    log.info({ jobId: job.id, ...payload, result: r }, "explain done");
  },
);

await boss.work(QUEUES.brief.name, { localConcurrency: 2, batchSize: 1 }, async ([job]) => {
  if (!job) return;
  const payload = briefPayload.parse(job.data);
  const r = await timed("brief", () =>
    runBrief(
      {
        db,
        client: anthropic,
        model: config.AI_MODEL,
        effort: config.AI_EFFORT,
        log: (o, m) => log.info(o, m),
      },
      payload,
    ),
  );
  log.info({ jobId: job.id, ...payload, result: r }, "brief done");
});

// one at a time: building a demo tower simulates three weeks of a 12-floor building
await boss.work(QUEUES.demo.name, { localConcurrency: 1, batchSize: 1 }, async ([job]) => {
  if (!job) return;
  const payload = demoPayload.parse(job.data);
  const r = await timed("demo", () => runDemoWorkspace(db, payload));
  log.info({ jobId: job.id, ...payload, result: r }, "demo workspace done");
});

await boss.work(QUEUES.nightly.name, { batchSize: 1 }, async () => {
  const r = await timed("nightly", () => runNightly(db, jobs, { localHour: config.NIGHTLY_LOCAL_HOUR }));
  log.info(r, "nightly tick");
});
await boss.schedule(QUEUES.nightly.name, "5 * * * *", {}, { tz: "UTC" });

// jobs that exhausted their retries: make the failure visible where people look
await boss.work(QUEUES.deadLetter.name, { batchSize: 10 }, async (dead) => {
  for (const job of dead) {
    const recompute = recomputePayload.safeParse(job.data);
    if (recompute.success) {
      await markRecomputeFailed(db, recompute.data);
      log.error({ jobId: job.id, ...recompute.data }, "recompute gave up; batches marked failed");
      continue;
    }
    const explain = explainPayload.safeParse(job.data);
    if (explain.success) {
      await withOrg(db, explain.data.orgId, (tx) =>
        tx
          .update(schema.aiExplanations)
          .set({
            status: "failed",
            error: "The AI service was unavailable; try again later.",
            completedAt: new Date(),
          })
          .where(eq(schema.aiExplanations.id, explain.data.explanationId)),
      );
      log.error({ jobId: job.id, ...explain.data }, "explanation gave up");
      continue;
    }
    const brief = briefPayload.safeParse(job.data);
    if (brief.success) {
      await withOrg(db, brief.data.orgId, (tx) =>
        tx
          .update(schema.aiBriefs)
          .set({
            status: "failed",
            draft: null,
            error: "The AI service was unavailable; try again later.",
            completedAt: new Date(),
          })
          .where(eq(schema.aiBriefs.id, brief.data.briefId)),
      );
      log.error({ jobId: job.id, ...brief.data }, "brief gave up");
      continue;
    }
    if (demoPayload.safeParse(job.data).success) {
      // the workspace stays empty; asking for it again from the app queues a new attempt
      log.error({ jobId: job.id, data: job.data }, "demo workspace gave up");
      continue;
    }
    log.error({ jobId: job.id, data: job.data }, "unrecognised dead-letter job");
  }
});

const server =
  config.HEALTH_PORT > 0
    ? createServer(async (req, res) => {
        if (req.url === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        } else if (req.url === "/metrics") {
          res.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
        } else res.writeHead(404).end();
      }).listen(config.HEALTH_PORT)
    : null;

log.info(
  { queues: Object.values(QUEUES).map((q) => q.name), ai: anthropic ? config.AI_MODEL : "disabled" },
  "worker started",
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "stopping: finishing active jobs");
  setTimeout(() => process.exit(1), 60_000).unref();
  await boss.stop({ graceful: true, timeout: 45_000 });
  server?.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
