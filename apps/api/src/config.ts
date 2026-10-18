import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** connection string of the runtime role (no BYPASSRLS) */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** browser origins allowed to call the API with credentials, comma separated */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /** public URL of the web app, used in invitation links */
  APP_URL: z.string().url().default("http://localhost:3000"),
  COOKIE_SECURE: bool,
  SESSION_IDLE_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 30)
    .default(12),
  SESSION_MAX_DAYS: z.coerce.number().min(1).max(90).default(7),
  /** "keep me signed in" sessions: idle window and absolute limit, in days */
  SESSION_REMEMBER_DAYS: z.coerce.number().min(1).max(365).default(30),
  SESSION_REMEMBER_MAX_DAYS: z.coerce.number().min(1).max(365).default(90),
  TRUST_PROXY: bool,
  /**
   * outgoing mail (sign-in and reset codes, invitations) through an SMTP relay, e.g.
   * smtps://user:app-password@smtp.gmail.com:465; unset = no mail (codes are logged in development)
   */
  SMTP_URL: z.string().url().optional(),
  /** sender, e.g. "FlowCarbon <noreply@example.com>"; defaults to the SMTP user */
  MAIL_FROM: z.string().min(3).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  /** sign-in attempts per IP per 15 minutes */
  LOGIN_ATTEMPTS_PER_15_MIN: z.coerce.number().int().min(1).default(10),
  /** bearer token required for /metrics; unset = metrics only reachable when METRICS_PUBLIC=true */
  METRICS_TOKEN: z.string().min(16).optional(),
  METRICS_PUBLIC: bool,
  DOCS_ENABLED: bool,
});

export type Config = Omit<
  z.infer<typeof schema>,
  "COOKIE_SECURE" | "TRUST_PROXY" | "METRICS_PUBLIC" | "DOCS_ENABLED"
> & {
  COOKIE_SECURE: boolean;
  TRUST_PROXY: boolean;
  METRICS_PUBLIC: boolean;
  DOCS_ENABLED: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // an empty variable (e.g. METRICS_TOKEN= in a compose file) means "not set"
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  const c = parsed.data;
  const production = c.NODE_ENV === "production";
  return {
    ...c,
    COOKIE_SECURE: c.COOKIE_SECURE ?? production,
    TRUST_PROXY: c.TRUST_PROXY ?? false,
    METRICS_PUBLIC: c.METRICS_PUBLIC ?? !production,
    DOCS_ENABLED: c.DOCS_ENABLED ?? true,
  };
}
