import { type Db, schema, type Tx } from "@flowcarbon/db";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { forbidden, notFound, unauthorized } from "../errors";
import { type Permission, type Role, roleCan, scopesCan } from "./permissions";

/** The caller's rights within one organisation. */
export interface OrgAccess {
  orgId: string;
  role: Role | null;
  /** tenant_admin members are limited to this tenant's floors */
  tenantId: string | null;
  /** API keys restricted to one building */
  buildingId: string | null;
  actor: { type: "user" | "api_key"; id: string };
  can(permission: Permission): boolean;
}

export async function orgAccess(db: Db, req: FastifyRequest, orgId: string): Promise<OrgAccess> {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (p.kind === "api_key") {
    if (p.orgId !== orgId) throw notFound("Organisation");
    return {
      orgId,
      role: null,
      tenantId: null,
      buildingId: p.buildingId,
      actor: { type: "api_key", id: p.apiKeyId },
      can: (perm) => scopesCan(p.scopes, perm),
    };
  }
  const [m] = await db
    .select({ role: schema.memberships.role, tenantId: schema.memberships.tenantId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, p.userId)));
  // not a member: answer as if the organisation did not exist
  if (!m) throw notFound("Organisation");
  return {
    orgId,
    role: m.role,
    tenantId: m.role === "tenant_admin" ? m.tenantId : null,
    buildingId: null,
    actor: { type: "user", id: p.userId },
    can: (perm) => roleCan(m.role, perm),
  };
}

export async function requireOrg(
  db: Db,
  req: FastifyRequest,
  orgId: string,
  permission: Permission,
): Promise<OrgAccess> {
  const access = await orgAccess(db, req, orgId);
  if (!access.can(permission)) throw forbidden();
  return access;
}

export function assertBuilding(access: OrgAccess, buildingId: string) {
  if (access.buildingId && access.buildingId !== buildingId) throw notFound("Building");
}

/** Floors the caller may see in a building: all of them, or the floors a tenant admin's tenant leases today. */
export async function visibleFloorIds(
  tx: Tx,
  access: OrgAccess,
  buildingId: string,
  today: string,
): Promise<Set<string> | null> {
  if (!access.tenantId) return null;
  const rows = await tx
    .select({ floorId: schema.leases.floorId })
    .from(schema.leases)
    .innerJoin(schema.floors, eq(schema.floors.id, schema.leases.floorId))
    .where(
      and(
        eq(schema.floors.buildingId, buildingId),
        eq(schema.leases.tenantId, access.tenantId),
        lte(schema.leases.startsOn, today),
        or(isNull(schema.leases.endsOn), gte(schema.leases.endsOn, today)),
      ),
    );
  return new Set(rows.map((r) => r.floorId));
}
