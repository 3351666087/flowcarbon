import { schema, type Tx } from "@flowcarbon/db";
import { eq, gte, sql } from "drizzle-orm";
import { HttpError } from "./errors";

/**
 * Demo organisations are open to anyone who signs up, so their AI use (explanations and building briefs together) is
 * capped per 24 hours. Runs inside the organisation's transaction.
 */
export async function assertAiQuota(tx: Tx, orgId: string, perDay: number) {
  const [org] = await tx
    .select({ plan: schema.organizations.plan })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  if (org?.plan !== "demo") return;
  const since = new Date(Date.now() - 86_400_000);
  const [explained] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.aiExplanations)
    .where(gte(schema.aiExplanations.createdAt, since));
  const [briefed] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.aiBriefs)
    .where(gte(schema.aiBriefs.createdAt, since));
  if ((explained?.n ?? 0) + (briefed?.n ?? 0) >= perDay)
    throw new HttpError(
      429,
      `A demo building gets ${perDay} AI answers a day. Try again tomorrow.`,
      "rate_limited",
    );
}
