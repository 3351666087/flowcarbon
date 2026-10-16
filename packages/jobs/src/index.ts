import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { z } from "zod";

export const JOB_SCHEMA = "pgboss";
export const APP_ROLE = "flowcarbon_app";

const DEAD_LETTER = "dead-letter";

/**
 * Queue definitions. `recompute` is `stately` per building (singleton key): at most one queued and one active job
 * per building, because a run processes every pending ingestion batch of the building, not just the one that
 * triggered it.
 */
export const QUEUES = {
  recompute: {
    name: "recompute",
    policy: "stately",
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    deleteAfterSeconds: 3 * 86_400,
    deadLetter: DEAD_LETTER,
  },
  explain: {
    name: "explain-finding",
    policy: "standard",
    retryLimit: 3,
    retryDelay: 20,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
    deleteAfterSeconds: 7 * 86_400,
    deadLetter: DEAD_LETTER,
  },
  nightly: {
    name: "nightly",
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 300,
    expireInSeconds: 60 * 60,
    deleteAfterSeconds: 14 * 86_400,
    deadLetter: DEAD_LETTER,
  },
  deadLetter: { name: DEAD_LETTER, policy: "standard", deleteAfterSeconds: 30 * 86_400 },
} as const;

export const recomputePayload = z.object({ orgId: z.uuid(), buildingId: z.uuid() });
export const explainPayload = z.object({ orgId: z.uuid(), explanationId: z.uuid() });
export type RecomputePayload = z.infer<typeof recomputePayload>;
export type ExplainPayload = z.infer<typeof explainPayload>;

/** What the API needs from the queue; an in-memory implementation is used in tests. */
export interface JobQueue {
  recompute(payload: RecomputePayload): Promise<string | null>;
  explain(payload: ExplainPayload): Promise<string | null>;
}

export class PgBossJobQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}
  recompute(payload: RecomputePayload) {
    return this.boss.send(QUEUES.recompute.name, payload, { singletonKey: payload.buildingId });
  }
  explain(payload: ExplainPayload) {
    return this.boss.send(QUEUES.explain.name, payload);
  }
}

/**
 * Creates a pg-boss instance for the runtime role. Schema creation and migrations are disabled: they need
 * DDL rights the runtime role does not have and run once per deploy through `installJobSchema`.
 */
export function createBoss(
  url: string,
  opts: { worker?: boolean; max?: number; applicationName?: string } = {},
): PgBoss {
  return new PgBoss({
    connectionString: url,
    schema: JOB_SCHEMA,
    application_name: opts.applicationName ?? "flowcarbon-jobs",
    max: opts.max ?? 4,
    migrate: false,
    createSchema: false,
    supervise: opts.worker ?? false,
    schedule: opts.worker ?? false,
  });
}

/**
 * Installs or upgrades the job schema and queues as the database owner, then grants the runtime role the data
 * rights it needs. Idempotent; run after the database migrations on every deploy.
 */
export async function installJobSchema(ownerUrl: string, appRole = APP_ROLE): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: JOB_SCHEMA,
    application_name: "flowcarbon-jobs-install",
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (err) => console.error("pg-boss", err));
  await boss.start();
  try {
    // the dead-letter queue must exist before queues that reference it
    const ordered = [QUEUES.deadLetter, QUEUES.recompute, QUEUES.explain, QUEUES.nightly];
    for (const { name, ...options } of ordered) {
      if (await boss.getQueue(name)) {
        const { policy: _policy, ...updatable } = options;
        await boss.updateQueue(name, updatable);
      } else await boss.createQueue(name, options);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const [role] = await sql`select 1 from pg_roles where rolname = ${appRole}`;
    if (!role) return;
    const s = sql(JOB_SCHEMA);
    const r = sql(appRole);
    await sql`grant usage on schema ${s} to ${r}`;
    await sql`grant select, insert, update, delete on all tables in schema ${s} to ${r}`;
    await sql`grant usage, select on all sequences in schema ${s} to ${r}`;
    await sql`grant execute on all functions in schema ${s} to ${r}`;
    await sql`alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`;
    await sql`alter default privileges in schema ${s} grant usage, select on sequences to ${r}`;
  } finally {
    await sql.end();
  }
}
