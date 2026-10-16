import { schema, type Tx } from "@flowcarbon/db";
import type { FastifyRequest } from "fastify";
import type { OrgAccess } from "./auth/access";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/** Records a mutation in the append-only audit log, inside the caller's transaction. */
export async function audit(
  tx: Tx,
  req: FastifyRequest,
  access: Pick<OrgAccess, "orgId" | "actor">,
  entry: AuditEntry,
) {
  await tx.insert(schema.auditLog).values({
    orgId: access.orgId,
    actorType: access.actor.type,
    actorId: access.actor.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    data: entry.data ?? null,
    ip: req.ip,
    requestId: String(req.id),
  });
}
