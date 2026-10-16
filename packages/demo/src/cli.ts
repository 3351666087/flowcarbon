import { parseArgs } from "node:util";
import { createDb } from "@flowcarbon/db";
import { randomToken } from "@flowcarbon/security";
import { recentWindow, seedDemo } from "./seed";

const { values } = parseArgs({
  options: {
    start: { type: "string" },
    days: { type: "string", default: "28" },
    seed: { type: "string" },
    slug: { type: "string", default: "tower-a-demo" },
    reset: { type: "boolean", default: false },
  },
});

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const days = Number(values.days);
const window = values.start ? { startDate: values.start, days } : recentWindow(days);
// never fall back to a fixed password: either the operator chooses one or a random one is printed once
const password = process.env.DEMO_PASSWORD ?? randomToken(12);

const { db, close } = createDb(url, { max: 2, statementTimeoutMs: 0, applicationName: "flowcarbon-seed" });
try {
  const started = Date.now();
  const r = await seedDemo(db, {
    slug: values.slug,
    startDate: window.startDate,
    days: window.days,
    seed: values.seed ? Number(values.seed) : undefined,
    password,
    reset: values.reset,
    log: (m) => console.log(`  ${m}`),
  });
  console.log(
    `seeded organisation ${values.slug} (${r.orgId}) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  console.log(`  ${window.startDate} + ${window.days} days, ${r.findings} findings`);
  console.log("  users:");
  for (const u of r.users) console.log(`    ${u.email.padEnd(36)} ${u.role}`);
  if (!process.env.DEMO_PASSWORD) console.log(`  password for all demo users (shown once): ${password}`);
} finally {
  await close();
}
