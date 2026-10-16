import {
  buildFloorIntervals,
  buildReport,
  detectFindings,
  type EmissionFactor,
  estimateStrategies,
  evaluateEpc,
  floorDayStats,
  forecastFloors,
  occupancyFromDoorCounts,
} from "@flowcarbon/core";
import { approvedWindows, sampleTower, simulate } from "@flowcarbon/sim";

const t0 = performance.now();
const sb = sampleTower();
const sim = simulate(sb, { startDate: "2026-09-15", days: 28 });
const tz = sb.building.timezone;
const occ = occupancyFromDoorCounts(sim.doorCounts, { timeZone: tz });
const occupancy = [...occ].flatMap(([floorId, pts]) =>
  pts.map((p) => ({ floorId, ts: p.start, count: p.count })),
);
const drift = [...occ.values()].flat().reduce((s, p) => s + (p.driftCorrected ?? 0), 0);
const intervals = buildFloorIntervals({
  floors: sb.floors,
  from: sim.from,
  to: sim.to,
  readings: sim.readings,
  hvacEvents: sim.hvacEvents,
  lightingEvents: sim.lightingEvents,
  occupancy,
});
const findings = detectFindings({
  building: sb.building,
  floors: sb.floors,
  intervals,
  approvedOvertime: approvedWindows(sim.overtime),
});
const factor: EmissionFactor = {
  id: "cn-2023",
  region: "CN",
  year: 2023,
  method: "location",
  kgPerKwh: 0.5703,
  source: "MEE national average grid factor",
  status: "to_verify",
};
const report = buildReport({
  building: sb.building,
  floors: sb.floors,
  intervals,
  findings,
  locationFactor: factor,
  from: sim.from,
  to: sim.to,
});
const stats = floorDayStats(sb.building, intervals);
const fc = forecastFloors(sb.building, sb.floors, stats, "2026-10-13", 7);
const est = estimateStrategies(findings, sb.floors, {
  observed: report.period.dayTypes,
  annual: { workday: 250, weekend: 104, holiday: 11 },
});
const full = est.find((e) => e.id === "full_package")!;
const epc = evaluateEpc({
  annualKwh: full.annualKwh,
  tariff: 0.85,
  achieved: 1,
  capex: full.capex,
  escoShare: 0.6,
  years: 5,
});
console.log({
  ms: Math.round(performance.now() - t0),
  doorCounts: sim.doorCounts.length,
  readings: sim.readings.length,
  overtime: sim.overtime.length,
  intervals: intervals.length,
  drift,
  totals: report.totals,
  days: report.period.dayTypes,
  byRule: report.byRule,
  findings: findings.length,
  strategies: est.map((e) => [e.id, e.annualKwh, e.capex]),
  epc: {
    annualSaving: Math.round(epc.annualSaving),
    owner: Math.round(epc.ownerAnnual),
    escoPayback: epc.escoPaybackYears.toFixed(2),
    selfPayback: epc.selfFundedPaybackYears.toFixed(2),
  },
  forecastF12: fc
    .filter((f) => f.floorId === "f12")
    .map((f) => `${f.dateKey}:${f.median}(${f.low}-${f.high})${f.advice}`),
  sample: findings.slice(0, 3).map((f) => f.evidence.summary),
});
