import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";
import { upsertReferenceData } from "./reference-data";

/** Bundled builds ship the SQL next to the bundle and point MIGRATIONS_DIR at it. */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies pending migrations and refreshes the shared reference data. Run as the database owner. */
export async function runMigrations(url: string, opts: { referenceData?: boolean } = {}): Promise<void> {
  const { db, close } = createDb(url, {
    max: 1,
    applicationName: "flowcarbon-migrate",
    statementTimeoutMs: 0,
  });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    if (opts.referenceData ?? true) await upsertReferenceData(db);
  } finally {
    await close();
  }
}
