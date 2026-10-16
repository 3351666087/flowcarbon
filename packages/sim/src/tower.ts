import type { BuildingProfile, FloorProfile, TenantProfile } from "@flowcarbon/core";

export interface SimTenant extends TenantProfile {
  industry: string;
  /** staff per leased floor */
  headcountPerFloor: number;
  /** after-hours cohort on working days: [min people, max people, earliest leave hour, latest leave hour] */
  overtime: [number, number, number, number];
  /** probability of a weekend overtime request */
  weekendRequestProb: number;
  floors: string[];
  contactEmail: string;
}

export interface SimBuilding {
  building: BuildingProfile;
  floors: FloorProfile[];
  tenants: SimTenant[];
  /** floors with refurbished sub-metering (hvac, lighting, plug) */
  meteredFloors: string[];
}

const HVAC_KW = 56; // 1,600 m² × 0.035 kW/m² electric for the floor's share of the central plant
const LIGHT_KW = 12.8; // 8 W/m²

/** "Tower A", a 12-floor office tower in Suzhou. Every name and number here is simulated. */
export function sampleTower(): SimBuilding {
  const tenants: SimTenant[] = [
    {
      id: "t-northwind",
      name: "Northwind Software",
      industry: "Software",
      headcountPerFloor: 130,
      overtime: [15, 35, 21, 23.5],
      weekendRequestProb: 0.45,
      overtimeRatePerHour: 180,
      floors: ["f12", "f13"],
      contactEmail: "facilities@northwind.example",
    },
    {
      id: "t-lumen",
      name: "Lumen Design Studio",
      industry: "Design",
      headcountPerFloor: 110,
      overtime: [8, 20, 20, 22.5],
      weekendRequestProb: 0.15,
      overtimeRatePerHour: 150,
      floors: ["f11"],
      contactEmail: "facilities@lumen.example",
    },
    {
      id: "t-cedar",
      name: "Cedar Health Tech",
      industry: "Health tech",
      headcountPerFloor: 120,
      overtime: [4, 12, 19, 21],
      weekendRequestProb: 0.1,
      overtimeRatePerHour: 150,
      floors: ["f14", "f15"],
      contactEmail: "facilities@cedar.example",
    },
    {
      id: "t-orchid",
      name: "Orchid Law Partners",
      industry: "Legal",
      headcountPerFloor: 90,
      overtime: [3, 10, 19, 22],
      weekendRequestProb: 0.05,
      overtimeRatePerHour: 150,
      floors: ["f7", "f16"],
      contactEmail: "facilities@orchid.example",
    },
    {
      id: "t-bluefield",
      name: "Bluefield Insurance",
      industry: "Insurance",
      headcountPerFloor: 140,
      overtime: [0, 4, 18, 19],
      weekendRequestProb: 0,
      overtimeRatePerHour: 150,
      floors: ["f8", "f9"],
      contactEmail: "facilities@bluefield.example",
    },
    {
      id: "t-kestrel",
      name: "Kestrel Logistics",
      industry: "Logistics",
      headcountPerFloor: 125,
      overtime: [0, 3, 18, 18.6],
      weekendRequestProb: 0,
      overtimeRatePerHour: 150,
      floors: ["f5", "f6"],
      contactEmail: "facilities@kestrel.example",
    },
  ];
  const tenantOf = new Map<string, string>();
  for (const t of tenants) for (const f of t.floors) tenantOf.set(f, t.id);
  const floors: FloorProfile[] = [];
  for (let level = 5; level <= 16; level++) {
    const id = `f${level}`;
    floors.push({
      id,
      label: `F${level}`,
      level,
      areaM2: 1600,
      tenantId: tenantOf.get(id) ?? null,
      ratedHvacKw: HVAC_KW,
      ratedLightingKw: LIGHT_KW,
      plugKwPerPerson: 0.12,
      zoneOnlyFraction: 0.3,
    });
  }
  return {
    building: {
      id: "b-tower-a",
      name: "Tower A",
      timezone: "Asia/Shanghai",
      currency: "CNY",
      workdayStart: "08:00",
      afterHoursStart: "18:00",
      tariff: { kind: "flat", rate: 0.85 },
      calendar: {
        holidays: [
          "2026-10-01",
          "2026-10-02",
          "2026-10-03",
          "2026-10-04",
          "2026-10-05",
          "2026-10-06",
          "2026-10-07",
        ],
        workdays: [],
      },
      gridRegion: "CN-East",
    },
    floors,
    tenants,
    meteredFloors: ["f11", "f12", "f13", "f14", "f15", "f16"],
  };
}
