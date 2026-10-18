import { type Db, schema, withOrg } from "@flowcarbon/db";
import { recentWindow, seedDemoBuilding } from "@flowcarbon/demo";
import type { DemoPayload } from "@flowcarbon/jobs";
import { eq } from "drizzle-orm";

/** days of simulated history a new demo workspace starts with */
export const DEMO_DAYS = 21;

/**
 * Builds the simulated tower in a person's own demo organisation, so they can work with the findings themselves.
 * Skips an organisation that is gone, is not a demo, or already has its building (a retried job).
 */
export async function runDemoWorkspace(
  db: Db,
  payload: DemoPayload,
  log?: (msg: string) => void,
): Promise<"seeded" | "skipped"> {
  const [org] = await db
    .select({ slug: schema.organizations.slug, plan: schema.organizations.plan })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, payload.orgId));
  if (org?.plan !== "demo") return "skipped";
  const [building] = await withOrg(db, payload.orgId, (tx) =>
    tx.select({ id: schema.buildings.id }).from(schema.buildings).limit(1),
  );
  if (building) return "skipped";
  await seedDemoBuilding(db, payload.orgId, { slug: org.slug, ...recentWindow(DEMO_DAYS), log });
  return "seeded";
}
