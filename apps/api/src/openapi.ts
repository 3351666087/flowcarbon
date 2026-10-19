// Writes the OpenAPI document without a database: `npm run openapi -w @flowcarbon/api > openapi.json`
import type { Db } from "@flowcarbon/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused@localhost/unused",
  DOCS_ENABLED: "true",
});
const app = await buildApp({
  db: {} as Db,
  config,
  jobs: {
    recompute: async () => null,
    explain: async () => null,
    demo: async () => null,
    brief: async () => null,
  },
  logger: false,
});
await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
