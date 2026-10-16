import { randomUUID } from "node:crypto";
import { runMigrations } from "@flowcarbon/db";
import postgres from "postgres";

export interface TestDatabase {
  name: string;
  /** owner connection (migrations, assertions that must bypass RLS) */
  ownerUrl: string;
  /** runtime role connection, row-level security in force */
  appUrl: string;
  drop(): Promise<void>;
}

/**
 * Creates a throw-away database on the server behind `adminUrl` (an owner/superuser URL), applies the migrations
 * and, optionally, installs the job schema. Requires the `flowcarbon_app` role (infra/postgres/init).
 */
export async function createTestDatabase(
  adminUrl: string,
  opts: { appPassword?: string; jobs?: (ownerUrl: string) => Promise<void> } = {},
): Promise<TestDatabase> {
  const name = `flowcarbon_it_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const base = new URL(adminUrl);
  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    u.pathname = `/${name}`;
    return u.toString();
  };
  const ownerUrl = urlFor(base.username, decodeURIComponent(base.password));
  await runMigrations(ownerUrl);
  if (opts.jobs) await opts.jobs(ownerUrl);
  return {
    name,
    ownerUrl,
    appUrl: urlFor(
      "flowcarbon_app",
      opts.appPassword ?? process.env.TEST_APP_PASSWORD ?? "flowcarbon-app-dev",
    ),
    async drop() {
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
