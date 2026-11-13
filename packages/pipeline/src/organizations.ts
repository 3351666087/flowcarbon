import { type Db, schema, withOrg } from "@flowcarbon/db";
import { eq } from "drizzle-orm";

/**
 * The tables with an org_id but no foreign key to it (the TimescaleDB hypertables and the daily roll-up, see
 * ADR 0002): the cascading delete of the organisation row does not reach them, so they are cleared first.
 */
const UNCONSTRAINED = [
  schema.energyReadings,
  schema.doorCounts,
  schema.hvacEvents,
  schema.lightingEvents,
  schema.floorIntervals,
  schema.floorDaily,
] as const;

/** Permanently deletes an organisation and everything it owns. */
export async function deleteOrganization(db: Db, orgId: string): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    for (const table of UNCONSTRAINED) await tx.delete(table).where(eq(table.orgId, orgId));
    await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  });
}
