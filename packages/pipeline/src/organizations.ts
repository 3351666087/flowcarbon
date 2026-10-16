import { type Db, schema, withOrg } from "@flowcarbon/db";
import { eq } from "drizzle-orm";

/**
 * Permanently deletes an organisation and everything it owns. The raw telemetry hypertables have no foreign
 * keys (see ADR 0002), so they are cleared explicitly before the cascading delete of the organisation row.
 */
export async function deleteOrganization(db: Db, orgId: string): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    await tx.delete(schema.energyReadings).where(eq(schema.energyReadings.orgId, orgId));
    await tx.delete(schema.doorCounts).where(eq(schema.doorCounts.orgId, orgId));
    await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  });
}
