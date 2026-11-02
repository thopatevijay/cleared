// M3-03 reads behind a goods hold's tracking summary, workspace-scoped: the newest `add_tracking` action
// per capture (the payload's `capture_id`; no extra column, so no migration), and the newest shipment
// fact (M2-03 `extracted_facts.facts.shipment`) per payment.
import { ShipmentFact, type Facts } from "@cleared/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor } from "../tx.ts";
import { evidenceItems, extractedFacts, proofPacks, proposedActions } from "../../schema/index.ts";
import type { ProposedActionRow } from "./proposed-actions.ts";

export type Shipment = NonNullable<Facts["shipment"]>;

export function trackingReads(db: Db, ws: string) {
  return {
    /** The newest `add_tracking` action per capture id. */
    async latestTrackingActions(
      captureIds: readonly string[],
      ex: Executor = db,
    ): Promise<Map<string, ProposedActionRow>> {
      if (captureIds.length === 0) return new Map();
      const capture = sql<string>`${proposedActions.payload}->>'capture_id'`;
      const rows = await ex
        .select()
        .from(proposedActions)
        .where(
          and(
            eq(proposedActions.workspaceId, ws),
            eq(proposedActions.kind, "add_tracking"),
            inArray(capture, [...captureIds]),
          ),
        )
        .orderBy(desc(proposedActions.createdAt), desc(proposedActions.id));
      const out = new Map<string, ProposedActionRow>();
      for (const r of rows) {
        const id = (r.payload as { capture_id?: unknown }).capture_id;
        if (typeof id === "string" && !out.has(id)) out.set(id, r);
      }
      return out;
    },

    /** The newest shipment fact in each payment's proof pack (any prompt version), re-validated. */
    async shipmentsByPayment(
      paymentIds: readonly string[],
      ex: Executor = db,
    ): Promise<Map<string, Shipment>> {
      if (paymentIds.length === 0) return new Map();
      const rows = await ex
        .select({
          paymentId: proofPacks.paymentId,
          shipment: sql<unknown>`${extractedFacts.facts}->'shipment'`,
        })
        .from(extractedFacts)
        .innerJoin(evidenceItems, eq(evidenceItems.id, extractedFacts.evidenceItemId))
        .innerJoin(proofPacks, eq(proofPacks.id, evidenceItems.packId))
        .where(
          and(
            eq(extractedFacts.workspaceId, ws),
            eq(evidenceItems.workspaceId, ws),
            eq(proofPacks.workspaceId, ws),
            inArray(proofPacks.paymentId, [...paymentIds]),
            sql`jsonb_typeof(${extractedFacts.facts}->'shipment') = 'object'`,
          ),
        )
        .orderBy(desc(extractedFacts.createdAt), desc(extractedFacts.id));
      const out = new Map<string, Shipment>();
      for (const r of rows) {
        const s = ShipmentFact.safeParse(r.shipment);
        if (s.success && !out.has(r.paymentId)) out.set(r.paymentId, s.data);
      }
      return out;
    },
  };
}
