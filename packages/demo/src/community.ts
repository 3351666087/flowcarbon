import { communityEntry, communitySummary, communityTitle } from "@flowcarbon/core";
import { type Db, schema, withOrg } from "@flowcarbon/db";
import { loadBuildingContext, planData } from "@flowcarbon/pipeline";
import { and, eq, isNull, sql } from "drizzle-orm";

interface SeededDataset {
  slug: string;
  /** the name its strategies appear under */
  alias: string;
  /** a building that was generated, not a public dataset: its strategies say so */
  simulated?: boolean;
}

/** The organisations whose strategies are seeded for everyone. */
export const PUBLIC_DATASETS: readonly SeededDataset[] = [
  { slug: "tower-a-demo", alias: "Simulated demo tower", simulated: true },
  { slug: "lbnl-b59-case", alias: "LBNL Building 59" },
];

/**
 * Lists what the planner suggests for the public datasets in the community, so an empty deployment has something to
 * compare with. Seeded rows belong to no organisation, which only the owner connection may write: row-level security
 * refuses them to the runtime role. Each building and option keeps one row, so running this again refreshes the
 * figures and leaves the count of uses alone. Figures stay expected: they are the planner's, even on measured data.
 */
export async function seedCommunity(
  db: Db,
  datasets: readonly SeededDataset[] = PUBLIC_DATASETS,
  log: (line: string) => void = () => {},
): Promise<{ rows: number }> {
  let rows = 0;
  for (const { slug, alias, simulated } of datasets) {
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    if (!org) {
      log(`no organisation ${slug}; skipped`);
      continue;
    }
    const buildings = await withOrg(db, org.id, (tx) =>
      // filtered by organisation as well as by row-level security, which an owner connection bypasses
      tx
        .select({ id: schema.buildings.id, name: schema.buildings.name })
        .from(schema.buildings)
        .where(and(eq(schema.buildings.orgId, org.id), isNull(schema.buildings.archivedAt))),
    );
    for (const b of buildings) {
      const written = await withOrg(db, org.id, async (tx) => {
        const ctx = await loadBuildingContext(tx, org.id, b.id);
        const plan = await planData(tx, ctx);
        for (const option of plan.options) {
          const planned = communityEntry(plan, option, ctx.floors);
          const entry = simulated ? { ...planned, result: { ...planned.result, simulated } } : planned;
          const text = {
            title: communityTitle(entry.optionKind, "en"),
            summary: communitySummary(entry, "en"),
          };
          await tx
            .insert(schema.communityStrategies)
            .values({ ...entry, ...text, orgId: null, buildingId: b.id, alias, locale: "en" })
            .onConflictDoUpdate({
              target: [schema.communityStrategies.buildingId, schema.communityStrategies.optionKind],
              targetWhere: sql`${schema.communityStrategies.orgId} is null`,
              set: { ...entry, ...text, alias },
            });
        }
        return plan.options.length;
      });
      rows += written;
      log(`${slug} / ${b.name}: ${written} strategies`);
    }
  }
  return { rows };
}
