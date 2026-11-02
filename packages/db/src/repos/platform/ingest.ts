// Ingest tables: raw webhook events (ADR 0012) and PayPal resource ownership (ADR 0008).
import type { PayPalResourceType } from "@cleared/core";
import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { paypalResourceOwner, webhookEvents, type WebhookEventStatus } from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { isUuid } from "../workspace/scoped.ts";

export type WebhookEventRow = InferSelectModel<typeof webhookEvents>;
export type NewWebhookEvent = Omit<
  InferInsertModel<typeof webhookEvents>,
  "id" | "status" | "processedAt" | "quarantineReason"
>;
export type ResourceOwnerRow = InferSelectModel<typeof paypalResourceOwner>;

export function webhookEventsRepo(db: Db) {
  return {
    /** Inserts the raw event; `null` when (provider, event_id) already exists (ON CONFLICT DO NOTHING). */
    async insertRaw(values: NewWebhookEvent, tx?: Executor): Promise<WebhookEventRow | null> {
      const rows = await (tx ?? db).insert(webhookEvents).values(values).onConflictDoNothing().returning();
      return rows[0] ?? null;
    },
    async get(id: string, tx?: Executor): Promise<WebhookEventRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db).select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
      return rows[0] ?? null;
    },
    async setStatus(
      id: string,
      next: { status: WebhookEventStatus; processedAt?: Date; quarantineReason?: string },
      tx?: Executor,
    ): Promise<WebhookEventRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db)
        .update(webhookEvents)
        .set(next)
        .where(eq(webhookEvents.id, id))
        .returning();
      return rows[0] ?? null;
    },
  };
}

export function resourceOwnersRepo(db: Db) {
  async function get(
    resourceType: PayPalResourceType,
    resourceId: string,
    tx?: Executor,
  ): Promise<ResourceOwnerRow | null> {
    const rows = await (tx ?? db)
      .select()
      .from(paypalResourceOwner)
      .where(
        and(
          eq(paypalResourceOwner.resourceType, resourceType),
          eq(paypalResourceOwner.resourceId, resourceId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  return {
    get,
    /** Records the owner; an existing row is kept (the first owner wins) and returned as-is. */
    async claim(
      owner: {
        resourceType: PayPalResourceType;
        resourceId: string;
        workspaceId: string;
        /** ADR 0019: a child of a moved resource inherits where its parent came from */
        transferredFrom?: string | null;
      },
      tx?: Executor,
    ): Promise<ResourceOwnerRow> {
      const ex = tx ?? db;
      await ex.insert(paypalResourceOwner).values(owner).onConflictDoNothing();
      const row = await get(owner.resourceType, owner.resourceId, ex);
      if (!row) throw new Error("resource owner row missing after claim");
      return row;
    },
  };
}
