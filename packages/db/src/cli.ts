import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { upsertReferenceData } from "./reference-data";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  process.exit(1);
}
const command = process.argv[2] ?? "migrate";

async function main(url: string) {
  if (command === "migrate") {
    await runMigrations(url);
    console.log("migrations applied, reference data up to date");
  } else if (command === "reference-data") {
    const { db, close } = createDb(url, { max: 1 });
    try {
      console.log(`reference factors upserted: ${await upsertReferenceData(db)}`);
    } finally {
      await close();
    }
  } else {
    throw new Error(`unknown command ${command}; use migrate or reference-data`);
  }
}

main(url).catch((err) => {
  console.error(err);
  process.exit(1);
});
