import type { FloorProfile, HvacMode, TenantProfile } from "./model";
import { HOUR } from "./time";

export type OvertimeStatus = "requested" | "approved" | "declined" | "cancelled";

export interface OvertimeRequestInput {
  tenantId: string;
  floorId: string;
  start: number;
  hours: number;
  expectedPeople: number;
}

export interface OvertimeTriage {
  mode: Exclude<HvacMode, "off">;
  fee: number;
  note: string;
}

export const MAX_OVERTIME_HOURS = 16;

export function validateOvertimeRequest(
  req: OvertimeRequestInput,
  ctx: { tenantFloors: readonly string[]; now: number },
): string[] {
  const errors: string[] = [];
  if (!ctx.tenantFloors.includes(req.floorId))
    errors.push("Tenants can only request cooling for floors they lease.");
  if (!(req.hours > 0 && req.hours <= MAX_OVERTIME_HOURS))
    errors.push(`Hours must be between 0 and ${MAX_OVERTIME_HOURS}.`);
  if (Math.round(req.hours * 4) !== req.hours * 4) errors.push("Hours must be in steps of 15 minutes.");
  if (!(Number.isInteger(req.expectedPeople) && req.expectedPeople >= 1))
    errors.push("Expected people must be a whole number ≥ 1.");
  if (req.start + req.hours * HOUR <= ctx.now) errors.push("The requested period is already over.");
  return errors;
}

/**
 * Suggests how to serve a request. The property manager decides; this only pre-fills the decision.
 * Below the threshold a zone setback serves the people present at a fraction of the energy.
 */
export function triageOvertime(
  req: OvertimeRequestInput,
  tenant: TenantProfile,
  floor: FloorProfile,
  fullFloorMinPeople = 3,
): OvertimeTriage {
  const fee = Math.round(req.hours * tenant.overtimeRatePerHour * 100) / 100;
  if (req.expectedPeople >= fullFloorMinPeople) {
    return {
      mode: "full",
      fee,
      note: `Recommendation: full-floor cooling for ${floor.label} (${req.expectedPeople} people expected, threshold ${fullFloorMinPeople}).`,
    };
  }
  return {
    mode: "setback",
    fee,
    note: `Recommendation: zone setback at 26 °C for the requester's area only (${req.expectedPeople} people expected, below the threshold of ${fullFloorMinPeople}).`,
  };
}
