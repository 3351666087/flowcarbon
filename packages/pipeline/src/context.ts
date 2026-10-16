import type { BuildingProfile, EmissionFactor, FloorProfile, TenantProfile } from "@flowcarbon/core";
import { localParts, selectFactor } from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, isNull, or } from "drizzle-orm";

export interface BuildingContext {
  orgId: string;
  building: BuildingProfile;
  bucketMinutes: number;
  ruleParams: Record<string, unknown>;
  floors: FloorProfile[];
  tenants: TenantProfile[];
  /** floor id → tenant id currently leasing it */
  floorTenant: Map<string, string>;
  factors: EmissionFactor[];
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

/** Loads everything the engine needs about one building, inside an org-scoped transaction. */
export async function loadBuildingContext(
  tx: Tx,
  orgId: string,
  buildingId: string,
): Promise<BuildingContext> {
  const [b] = await tx
    .select()
    .from(schema.buildings)
    .where(and(eq(schema.buildings.id, buildingId), eq(schema.buildings.orgId, orgId)));
  if (!b) throw new NotFoundError("building not found");
  const [floors, tenants, leases, days, factors] = await Promise.all([
    tx
      .select()
      .from(schema.floors)
      .where(eq(schema.floors.buildingId, buildingId))
      .orderBy(schema.floors.level),
    tx.select().from(schema.tenants).where(eq(schema.tenants.buildingId, buildingId)),
    tx
      .select({
        floorId: schema.leases.floorId,
        tenantId: schema.leases.tenantId,
        endsOn: schema.leases.endsOn,
        startsOn: schema.leases.startsOn,
      })
      .from(schema.leases)
      .innerJoin(schema.floors, eq(schema.floors.id, schema.leases.floorId))
      .where(eq(schema.floors.buildingId, buildingId)),
    tx.select().from(schema.calendarDays).where(eq(schema.calendarDays.buildingId, buildingId)),
    tx
      .select()
      .from(schema.emissionFactors)
      .where(or(isNull(schema.emissionFactors.orgId), eq(schema.emissionFactors.orgId, orgId))),
  ]);
  const today = localParts(Date.now(), b.timezone).dateKey;
  const floorTenant = new Map<string, string>();
  for (const l of leases)
    if (l.startsOn <= today && (!l.endsOn || l.endsOn >= today)) floorTenant.set(l.floorId, l.tenantId);

  return {
    orgId,
    bucketMinutes: b.bucketMinutes,
    ruleParams: b.ruleParams,
    building: {
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      currency: b.currency,
      workdayStart: b.workdayStart,
      afterHoursStart: b.afterHoursStart,
      tariff: b.tariff,
      gridRegion: b.gridRegion,
      calendar: {
        holidays: days.filter((d) => d.kind === "holiday").map((d) => d.day),
        workdays: days.filter((d) => d.kind === "workday").map((d) => d.day),
      },
    },
    floors: floors.map((f) => ({
      id: f.id,
      label: f.label,
      level: f.level,
      areaM2: f.areaM2,
      tenantId: floorTenant.get(f.id) ?? null,
      ratedHvacKw: f.ratedHvacKw,
      ratedLightingKw: f.ratedLightingKw,
      plugKwPerPerson: f.plugKwPerPerson,
      zoneOnlyFraction: f.zoneOnlyFraction,
    })),
    tenants: tenants.map((t) => ({ id: t.id, name: t.name, overtimeRatePerHour: t.overtimeRatePerHour })),
    floorTenant,
    factors: factors.map((f) => ({
      id: f.id,
      region: f.region,
      year: f.year,
      method: f.method,
      kgPerKwh: f.kgPerKwh,
      source: f.source,
      status: f.status,
    })),
  };
}

export class ConfigurationError extends Error {
  readonly statusCode = 422;
}

export function locationFactorFor(ctx: BuildingContext, year: number): EmissionFactor {
  const f = selectFactor(ctx.factors, { region: ctx.building.gridRegion, year, method: "location" });
  if (!f)
    throw new ConfigurationError(
      `no location-based emission factor for region ${ctx.building.gridRegion} up to ${year}`,
    );
  return f;
}

/** Local calendar date of a timestamp in the building's time zone. */
export function localDateOf(ctx: BuildingContext, ts: number): string {
  return localParts(ts, ctx.building.timezone).dateKey;
}
