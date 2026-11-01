/**
 * Lists the strategies the planner suggests for the public datasets in the community, for operators. Safe to run again:
 * it refreshes the same rows. Rows from a dataset belong to no organisation, so this needs the owner connection.
 *
 * usage: DATABASE_MIGRATION_URL=postgres://... node community.mjs [--slug tower-a-demo --slug lbnl-b59-case]
 * (every public dataset by default; an organisation that is not there is skipped)
 */
import { parseArgs } from "node:util";
import { createDb } from "@flowcarbon/db";
import { PUBLIC_DATASETS, seedCommunity } from "./community";

const { values } = parseArgs({ options: { slug: { type: "string", multiple: true, default: [] } } });
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL is required");
  process.exit(1);
}
const wanted = values.slug;
const unknown = wanted.filter((slug) => !PUBLIC_DATASETS.some((d) => d.slug === slug));
if (unknown.length) {
  console.error(`not a public dataset: ${unknown.join(", ")}`);
  process.exit(1);
}

const { db, close } = createDb(url, {
  max: 2,
  statementTimeoutMs: 0,
  applicationName: "flowcarbon-community",
});
try {
  const datasets = wanted.length ? PUBLIC_DATASETS.filter((d) => wanted.includes(d.slug)) : PUBLIC_DATASETS;
  const { rows } = await seedCommunity(db, datasets, console.log);
  console.log(`done: ${rows} strategies`);
} finally {
  await close();
}
