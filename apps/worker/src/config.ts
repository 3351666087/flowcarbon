import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  /** runtime role connection (no BYPASSRLS) */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(6),
  /** concurrent recompute jobs per worker process */
  RECOMPUTE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  EXPLAIN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** local hour at which each building's nightly work runs */
  NIGHTLY_LOCAL_HOUR: z.coerce.number().int().min(0).max(23).default(4),
  /** AI explanations are disabled when no credentials are configured */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** required for keys that are not scoped to a workspace (sent as the anthropic-workspace-id header) */
  ANTHROPIC_WORKSPACE_ID: z.string().min(1).optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** port for /healthz and /metrics; 0 disables the endpoint */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(4100),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // an empty variable (e.g. ANTHROPIC_API_KEY= in a compose file) means "not set"
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!parsed.success)
    throw new Error(
      `invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}
