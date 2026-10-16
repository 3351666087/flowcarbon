import { localParts } from "@flowcarbon/core";
import { type Db, schema, type Tx, withOrg } from "@flowcarbon/db";
import { type BuildingContext, loadBuildingContext } from "@flowcarbon/pipeline";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { assertBuilding, type OrgAccess, requireOrg } from "../auth/access";
import type { Permission } from "../auth/permissions";
import { notFound } from "../errors";

export type BuildingRow = typeof schema.buildings.$inferSelect;

/** Authorises the caller for a building and runs `fn` in an organisation-scoped transaction. */
export async function inBuilding<T>(
  db: Db,
  req: FastifyRequest,
  params: { orgId: string; buildingId: string },
  permission: Permission,
  fn: (tx: Tx, access: OrgAccess, building: BuildingRow) => Promise<T>,
): Promise<T> {
  const access = await requireOrg(db, req, params.orgId, permission);
  assertBuilding(access, params.buildingId);
  return withOrg(db, params.orgId, async (tx) => {
    const [b] = await tx.select().from(schema.buildings).where(eq(schema.buildings.id, params.buildingId));
    if (!b) throw notFound("Building");
    return fn(tx, access, b);
  });
}

/** Like `inBuilding`, with the full engine context loaded. */
export async function withBuildingContext<T>(
  db: Db,
  req: FastifyRequest,
  params: { orgId: string; buildingId: string },
  permission: Permission,
  fn: (tx: Tx, access: OrgAccess, ctx: BuildingContext) => Promise<T>,
): Promise<T> {
  const access = await requireOrg(db, req, params.orgId, permission);
  assertBuilding(access, params.buildingId);
  return withOrg(db, params.orgId, async (tx) =>
    fn(tx, access, await loadBuildingContext(tx, params.orgId, params.buildingId)),
  );
}

export function todayIn(timeZone: string): string {
  return localParts(Date.now(), timeZone).dateKey;
}

export function addDaysKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Validates a [from, to) local-date range and its length. */
export function dateRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
  defaultDays: number,
  maxDays = 400,
) {
  const toKey = to ?? addDaysKey(today, 1);
  const fromKey = from ?? addDaysKey(toKey, -defaultDays);
  const days = (Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000;
  if (!(days >= 1 && days <= maxDays)) return null;
  return { from: fromKey, to: toKey, days };
}
