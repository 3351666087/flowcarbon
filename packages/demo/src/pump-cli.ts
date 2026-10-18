import { parseArgs } from "node:util";
import { createDb } from "@flowcarbon/db";
import { pumpAllDemos, pumpDemo } from "./pump";

const { values } = parseArgs({
  options: {
    /** one organisation; without it every demo organisation is kept live */
    slug: { type: "string" },
    once: { type: "boolean", default: false },
  },
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const everyMs = Number(process.env.PUMP_INTERVAL_MINUTES ?? 15) * 60_000;
const { db, close } = createDb(url, {
  max: 2,
  statementTimeoutMs: 0,
  applicationName: "flowcarbon-demo-pump",
});

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });

const run = async () => {
  try {
    const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
    if (values.slug) await pumpDemo(db, { slug: values.slug, log: (m) => log(m) });
    else
      for (const r of await pumpAllDemos(db, { log: (m) => log(m) }))
        if (r.error) log(`${r.slug}: ${r.error}`);
  } catch (err) {
    // keep running: the next tick catches up whatever this one missed
    console.error(`${new Date().toISOString()} pump failed:`, err instanceof Error ? err.message : err);
    if (values.once) process.exitCode = 1;
  }
};

try {
  await run();
  while (!values.once && !stopping) {
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, everyMs);
    });
    if (!stopping) await run();
  }
} finally {
  await close();
}
