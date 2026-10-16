import { z } from "zod";

export const uuid = z.uuid();
export const dateKey = z.iso.date();
export const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
export const timestamp = z.iso.datetime({ offset: true });

export const orgParams = z.object({ orgId: uuid });
export const buildingParams = z.object({ orgId: uuid, buildingId: uuid });

export const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
  requestId: z.string(),
});

export const errorResponses = {
  400: problem,
  401: problem,
  403: problem,
  404: problem,
  409: problem,
  422: problem,
};

export const roleSchema = z.enum([
  "owner",
  "admin",
  "property_manager",
  "energy_analyst",
  "engineer",
  "tenant_admin",
  "viewer",
]);

export const tariffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flat"), rate: z.number().min(0).max(100) }),
  z.object({
    kind: z.literal("tou"),
    defaultRate: z.number().min(0).max(100),
    periods: z
      .array(
        z.object({
          name: z.string().min(1).max(40),
          start: clock,
          end: clock,
          rate: z.number().min(0).max(100),
        }),
      )
      .min(1)
      .max(24),
  }),
]);

export const ruleParamsSchema = z
  .object({
    emptyGraceMinutes: z.number().int().min(5).max(240),
    lightsNightStart: clock,
    lightsNightEnd: clock,
    lightsMinLevel: z.number().min(0).max(1),
    lightsGraceMinutes: z.number().int().min(0).max(240),
    fullFloorMinPeople: z.number().int().min(1).max(100),
    minFindingKwh: z.number().min(0).max(10_000),
    startupWindowMinutes: z.number().int().min(0).max(240),
  })
  .partial();

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Encodes a keyset pagination cursor. */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
