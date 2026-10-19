export const ROLES = [
  "owner",
  "admin",
  "property_manager",
  "energy_analyst",
  "engineer",
  "tenant_admin",
  "viewer",
] as const;
export type Role = (typeof ROLES)[number];

const ALL: Role[] = [...ROLES];
const STAFF: Role[] = ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"];
const ADMINS: Role[] = ["owner", "admin"];

/**
 * Role → permission matrix. `tenant_admin` members are additionally restricted to the floors their tenant leases
 * wherever data is per floor (see `scope.ts`).
 */
export const PERMISSIONS = {
  "org:read": ALL,
  /** rename the organisation */
  "org:manage": ADMINS,
  /** delete it, with everything in it */
  "org:delete": ["owner"],
  "members:manage": ADMINS,
  "apikeys:manage": ADMINS,
  "audit:read": ADMINS,
  "building:read": ALL,
  "building:write": ["owner", "admin", "property_manager"],
  "telemetry:write": ["owner", "admin", "property_manager"],
  "finding:read": STAFF,
  "finding:review": ["owner", "admin", "property_manager", "engineer"],
  "finding:explain": ["owner", "admin", "property_manager", "engineer", "energy_analyst"],
  "forecast:read": STAFF,
  "strategy:read": STAFF,
  "scenario:write": ["owner", "admin", "property_manager", "engineer", "energy_analyst"],
  "report:read": STAFF,
  "report:snapshot": ["owner", "admin", "energy_analyst"],
  "factor:write": ["owner", "admin", "energy_analyst"],
  "usage:read": ALL,
  "overtime:read": ALL,
  "overtime:request": ["owner", "admin", "property_manager", "tenant_admin"],
  "overtime:decide": ["owner", "admin", "property_manager"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** API keys carry scopes instead of a role. */
export const SCOPE_PERMISSIONS: Record<string, readonly Permission[]> = {
  "telemetry:write": ["building:read", "telemetry:write"],
  read: [
    "org:read",
    "building:read",
    "finding:read",
    "forecast:read",
    "strategy:read",
    "report:read",
    "usage:read",
    "overtime:read",
  ],
  "overtime:write": ["building:read", "overtime:read", "overtime:request"],
};

export function roleCan(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function scopesCan(scopes: readonly string[], permission: Permission): boolean {
  return scopes.some((s) => SCOPE_PERMISSIONS[s]?.includes(permission));
}

/** Roles a member may grant: admins cannot create owners. */
export function canGrant(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
