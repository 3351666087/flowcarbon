import { NO_AI } from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { HttpError } from "./errors";

/**
 * Demo organisations are open to anyone who signs up, so their AI use (explanations, building briefs and turns with
 * the assistant together) is capped per 24 hours. Runs inside the organisation's transaction.
 */
export async function aiQuotaLeft(tx: Tx, orgId: string, perDay: number): Promise<boolean> {
  const [org] = await tx
    .select({ plan: schema.organizations.plan })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  if (org?.plan !== "demo") return true;
  const since = new Date(Date.now() - 86_400_000);
  const [explained] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.aiExplanations)
    .where(gte(schema.aiExplanations.createdAt, since));
  const [briefed] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.aiBriefs)
    .where(gte(schema.aiBriefs.createdAt, since));
  const [asked] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.assistantTurns)
    .where(
      and(
        eq(schema.assistantTurns.orgId, orgId),
        gte(schema.assistantTurns.createdAt, since),
        // a turn that failed never answered anyone
        ne(schema.assistantTurns.status, "failed"),
        sql`${schema.assistantTurns.promptVersion} is distinct from ${NO_AI}`,
      ),
    );
  return (explained?.n ?? 0) + (briefed?.n ?? 0) + (asked?.n ?? 0) < perDay;
}

/** For what cannot be done without a model. The assistant can, so it asks `aiQuotaLeft` instead. */
export async function assertAiQuota(tx: Tx, orgId: string, perDay: number) {
  if (!(await aiQuotaLeft(tx, orgId, perDay)))
    throw new HttpError(
      429,
      `A demo building gets ${perDay} AI answers a day. Try again tomorrow.`,
      "ai_quota",
      { perDay },
    );
}
