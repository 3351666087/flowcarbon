// One-shot deploy step, run as the database owner: schema migrations, shared reference data, job queues.
import { runMigrations } from "@flowcarbon/db";
import { installJobSchema } from "@flowcarbon/jobs";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL is required");
  process.exit(1);
}
await runMigrations(url);
console.log("database migrations applied, reference data up to date");
await installJobSchema(url);
console.log("job queues installed");
