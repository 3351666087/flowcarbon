import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { emissionFactors } from "./schema";

export interface ReferenceFactor {
  region: string;
  year: number;
  method: "location" | "market";
  kgPerKwh: number;
  source: string;
  status: "verified" | "to_verify";
}

const MEE_2023 =
  "MEE & NBS, 2023 electricity CO2 emission factors (MEE Q&A, 5 Jan 2026, https://www.mee.gov.cn/ywdt/zbft/202601/t20260105_1139911.shtml)";
const MEE_2022 =
  "MEE & NBS announcement on 2022 electricity CO2 emission factors (Dec 2024, https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202412/t20241226_1099413.html)";
const MEE_2021 = "MEE & NBS announcement on 2021 electricity CO2 emission factors (Apr 2024)";
const EGRID_2018 =
  "US EPA eGRID2018 summary tables, subregion CAMX (WECC California) CO2e total output emission rate 498.7 lb/MWh (https://www.epa.gov/sites/default/files/2020-01/documents/egrid2018_summary_tables.pdf)";
const EGRID_2019 =
  "US EPA eGRID2019 summary tables, subregion CAMX (WECC California) CO2e total output emission rate 455.3 lb/MWh (https://www.epa.gov/sites/default/files/2021-02/documents/egrid2019_summary_tables.pdf)";

/**
 * Shared emission-factor library (organisation-independent). Values marked `verified` were checked against
 * the official text cited in `source`; `to_verify` values come from the same series but were not checked
 * line by line and must be confirmed before external disclosure. Organisations can add their own factors,
 * which take precedence through region specificity and year.
 *
 * Regions are hierarchical codes: CN (national) > CN-<grid> (regional grid) > CN-<grid>-<province>. US eGRID
 * subregions are US-<subregion>, e.g. US-CAMX for California (lb/MWh × 0.45359 / 1000 = kg/kWh).
 * "market" rows are the national factor excluding market-traded non-fossil electricity, the published
 * analogue of a residual mix for market-based Scope 2.
 */
export const REFERENCE_FACTORS: readonly ReferenceFactor[] = [
  // case data from California (LBNL Building 59): EPA eGRID subregion factors
  {
    region: "US-CAMX",
    year: 2018,
    method: "location",
    kgPerKwh: 0.2262,
    source: EGRID_2018,
    status: "verified",
  },
  {
    region: "US-CAMX",
    year: 2019,
    method: "location",
    kgPerKwh: 0.2065,
    source: EGRID_2019,
    status: "verified",
  },
  { region: "CN", year: 2023, method: "location", kgPerKwh: 0.5306, source: MEE_2023, status: "verified" },
  { region: "CN", year: 2022, method: "location", kgPerKwh: 0.5366, source: MEE_2023, status: "verified" },
  { region: "CN", year: 2021, method: "location", kgPerKwh: 0.5568, source: MEE_2021, status: "to_verify" },
  {
    region: "CN-North",
    year: 2023,
    method: "location",
    kgPerKwh: 0.6361,
    source: MEE_2023,
    status: "verified",
  },
  {
    region: "CN-Northeast",
    year: 2023,
    method: "location",
    kgPerKwh: 0.5122,
    source: MEE_2023,
    status: "verified",
  },
  { region: "CN-East", year: 2023, method: "location", kgPerKwh: 0.55, source: MEE_2023, status: "verified" },
  {
    region: "CN-Central",
    year: 2023,
    method: "location",
    kgPerKwh: 0.5271,
    source: MEE_2023,
    status: "verified",
  },
  {
    region: "CN-Northwest",
    year: 2023,
    method: "location",
    kgPerKwh: 0.5543,
    source: MEE_2023,
    status: "verified",
  },
  {
    region: "CN-South",
    year: 2023,
    method: "location",
    kgPerKwh: 0.4042,
    source: MEE_2023,
    status: "verified",
  },
  {
    region: "CN-Southwest",
    year: 2023,
    method: "location",
    kgPerKwh: 0.2472,
    source: MEE_2023,
    status: "verified",
  },
  {
    region: "CN-East",
    year: 2022,
    method: "location",
    kgPerKwh: 0.5617,
    source: MEE_2022,
    status: "to_verify",
  },
  {
    region: "CN-East",
    year: 2021,
    method: "location",
    kgPerKwh: 0.5992,
    source: MEE_2021,
    status: "to_verify",
  },
  {
    region: "CN-East-JS",
    year: 2022,
    method: "location",
    kgPerKwh: 0.5978,
    source: MEE_2022,
    status: "to_verify",
  },
  { region: "CN", year: 2023, method: "market", kgPerKwh: 0.6096, source: MEE_2023, status: "verified" },
  { region: "CN", year: 2022, method: "market", kgPerKwh: 0.5856, source: MEE_2023, status: "verified" },
];

/** Upserts the shared library. Idempotent; run after migrations. */
export async function upsertReferenceData(db: Db): Promise<number> {
  await db
    .insert(emissionFactors)
    .values(REFERENCE_FACTORS.map((f) => ({ ...f, orgId: null })))
    .onConflictDoUpdate({
      target: [emissionFactors.orgId, emissionFactors.region, emissionFactors.year, emissionFactors.method],
      set: { kgPerKwh: sql`excluded.kg_per_kwh`, source: sql`excluded.source`, status: sql`excluded.status` },
    });
  return REFERENCE_FACTORS.length;
}
