import { randomUUID } from "node:crypto";
import { type Db, schema, type Tx, withOrg } from "@flowcarbon/db";
import { and, eq, like, sql } from "drizzle-orm";
import { HttpError } from "./errors";

/** slug prefix of personal demo organisations (the shared demonstration has its own slug) */
export const PERSONAL_DEMO = "demo-";

export interface DemoWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** The person's own demo organisation, if they have one. */
export async function personalDemoOf(db: Db | Tx, userId: string): Promise<DemoWorkspace | null> {
  const [row] = await db
    .select({ id: schema.organizations.id, slug: schema.organizations.slug, name: schema.organizations.name })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.role, "owner"),
        eq(schema.organizations.plan, "demo"),
        like(schema.organizations.slug, `${PERSONAL_DEMO}%`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Creates a demo organisation the person owns, so they can review findings and agree measures themselves. The
 * simulated tower is built in it by a worker job (`jobs.demo`) once the transaction has committed.
 */
export async function createPersonalDemo(
  tx: Tx,
  user: { id: string; name: string; locale: string },
  opts: { max: number; ip?: string; requestId?: string },
): Promise<DemoWorkspace> {
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.plan, "demo"), like(schema.organizations.slug, `${PERSONAL_DEMO}%`)));
  if ((count?.n ?? 0) >= opts.max)
    throw new HttpError(
      503,
      "There is no room for another demo building right now. Try again later.",
      "unavailable",
    );
  const name = user.locale.startsWith("zh") ? `${user.name} 的演示大楼` : `${user.name}'s demo building`;
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name, slug: `${PERSONAL_DEMO}${randomUUID().slice(0, 8)}`, plan: "demo" })
    .returning({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
    });
  await tx.insert(schema.memberships).values({ orgId: org!.id, userId: user.id, role: "owner" });
  await tx.execute(sql`select set_config('app.org_id', ${org!.id}, true)`);
  await tx.insert(schema.auditLog).values({
    orgId: org!.id,
    actorType: "user",
    actorId: user.id,
    action: "demo.workspace",
    entityType: "organisation",
    entityId: org!.id,
    ip: opts.ip,
    requestId: opts.requestId,
  });
  return org!;
}

/** Whether the demo organisation's simulated building has been built yet. */
export async function demoReady(db: Db, orgId: string) {
  const rows = await withOrg(db, orgId, (tx) =>
    tx.select({ id: schema.buildings.id }).from(schema.buildings).limit(1),
  );
  return rows.length > 0;
}
