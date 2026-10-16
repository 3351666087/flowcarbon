import { createDb } from "@flowcarbon/db";
import { createBoss, PgBossJobQueue } from "@flowcarbon/jobs";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  applicationName: "flowcarbon-api",
});
const boss = createBoss(config.DATABASE_URL, { applicationName: "flowcarbon-api-jobs", max: 2 });
const app = await buildApp({ db, config, jobs: new PgBossJobQueue(boss) });
boss.on("error", (err) => app.log.error({ err }, "job queue error"));
await boss.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => process.exit(1), 20_000);
  timer.unref();
  try {
    await app.close();
    await boss.stop({ graceful: true, timeout: 10_000 });
    await close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });
