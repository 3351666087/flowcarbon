"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { ApiError, api, unwrap } from "./api";

export type Role =
  | "owner"
  | "admin"
  | "property_manager"
  | "energy_analyst"
  | "engineer"
  | "tenant_admin"
  | "viewer";

/** Which pages each role sees. The API enforces the same rules; this only hides what would be refused. */
export const PAGES: Record<string, Role[]> = {
  floors: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "tenant_admin", "viewer"],
  findings: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"],
  forecast: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"],
  simulate: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"],
  requests: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "tenant_admin", "viewer"],
  report: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"],
  data: ["owner", "admin", "property_manager", "energy_analyst", "engineer", "viewer"],
  settings: ["owner", "admin"],
};

export const can = {
  reviewFindings: (r?: Role) => !!r && ["owner", "admin", "property_manager", "engineer"].includes(r),
  explain: (r?: Role) =>
    !!r && ["owner", "admin", "property_manager", "engineer", "energy_analyst"].includes(r),
  decideOvertime: (r?: Role) => !!r && ["owner", "admin", "property_manager"].includes(r),
  requestOvertime: (r?: Role) => !!r && ["owner", "admin", "property_manager", "tenant_admin"].includes(r),
  snapshot: (r?: Role) => !!r && ["owner", "admin", "energy_analyst"].includes(r),
  saveScenario: (r?: Role) =>
    !!r && ["owner", "admin", "property_manager", "engineer", "energy_analyst"].includes(r),
  /** rename the organisation */
  manageOrg: (r?: Role) => !!r && ["owner", "admin"].includes(r),
  /** building settings, including the rule thresholds */
  editBuilding: (r?: Role) => !!r && ["owner", "admin", "property_manager"].includes(r),
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => unwrap(api.GET("/api/v1/me")),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });
}

export function useIds() {
  const p = useParams<{ orgId: string; buildingId: string }>();
  return { orgId: p.orgId, buildingId: p.buildingId };
}

export function useMembership() {
  const { orgId } = useIds();
  const me = useMe();
  return me.data?.memberships.find((m) => m.orgId === orgId);
}

export function useBuildings(orgId: string | undefined) {
  return useQuery({
    queryKey: ["buildings", orgId],
    enabled: !!orgId,
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/buildings", { params: { path: { orgId: orgId! } } })),
    staleTime: 5 * 60_000,
  });
}

export function useBuilding() {
  const { orgId, buildingId } = useIds();
  const q = useBuildings(orgId);
  return { ...q, building: q.data?.find((b) => b.id === buildingId) };
}

export function useFloors() {
  const { orgId, buildingId } = useIds();
  return useQuery({
    queryKey: ["floors", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/floors", {
          params: { path: { orgId, buildingId } },
        }),
      ),
    staleTime: 5 * 60_000,
  });
}

export function useTenants() {
  const { orgId, buildingId } = useIds();
  return useQuery({
    queryKey: ["tenants", orgId, buildingId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/tenants", {
          params: { path: { orgId, buildingId } },
        }),
      ),
    staleTime: 5 * 60_000,
  });
}
