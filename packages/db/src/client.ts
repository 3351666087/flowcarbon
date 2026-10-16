import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export interface DbOptions {
  /** max pool size; default 10 */
  max?: number;
  /** statement timeout in ms applied to every connection; default 30 s */
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function createDb(url: string, opts: DbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: {
      application_name: opts.applicationName ?? "flowcarbon",
      statement_timeout: opts.statementTimeoutMs ?? 30_000,
    },
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

/**
 * Runs `fn` in a transaction scoped to one organisation. Row-level security policies read `app.org_id`,
 * so even a query that forgets its org filter cannot see another organisation's rows when the
 * connection uses the non-privileged application role.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
