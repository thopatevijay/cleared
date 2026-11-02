// M3-03 test and E2E support: a goods hold (the M3-01 held payment, typed `goods`, with an order id) and,
// optionally, a shipment evidence item whose extracted facts name a carrier and tracking number. All
// synthetic (data policy): the sandbox can't produce a goods hold, so the hold row is written directly.
import { createHash, randomBytes } from "node:crypto";
import { FactsSchema, WorkspaceIdSchema } from "@cleared/core";
import { extractedFactsRepo, forWorkspace, withTransaction, type Db } from "@cleared/db";
import { seedHeldPayment } from "./hold-seed.ts";

export interface GoodsHoldOptions {
  /** what the shipment evidence says, e.g. { carrier: "India Post", tracking_number: "EE123456789IN" } */
  readonly shipment?: { readonly carrier: string; readonly tracking_number: string };
  readonly amount?: string;
}

export interface SeededGoodsHold {
  readonly holdId: string;
  readonly paymentId: string;
  readonly captureId: string;
  readonly orderId: string;
}

export async function seedGoodsHold(db: Db, ws: string, o: GoodsHoldOptions = {}): Promise<SeededGoodsHold> {
  const s = await seedHeldPayment(db, ws, {
    reason: "OTHER",
    ...(o.amount === undefined ? {} : { amount: o.amount }),
  });
  if (s.holdId === null) throw new Error("no hold derived");
  const holdId = s.holdId;
  const orderId = `E2EO${randomBytes(6).toString("hex").toUpperCase()}`;
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  await withTransaction(db, async (tx) => {
    await repos.holds.update(holdId, { type: "goods" }, tx);
    await repos.payments.update(s.paymentId, { orderId }, tx);
    if (o.shipment === undefined) return;
    const pack = await repos.proofPacks.getByPaymentId(s.paymentId, tx);
    if (pack === null) throw new Error("no proof pack");
    const text = `Shipped with ${o.shipment.carrier}, tracking ${o.shipment.tracking_number}.`;
    const item = await repos.evidenceItems.insert(
      { packId: pack.id, kind: "shipment", sha256: createHash("sha256").update(text).digest("hex"), text },
      tx,
    );
    const facts = FactsSchema.parse({
      parties: [],
      amounts: [],
      dates: [],
      deliverables: [],
      delivery_events: [],
      shipment: { ...o.shipment, evidence_item_id: item.id, source_quote: text },
      instruction_like_lines: [],
    });
    await extractedFactsRepo(db, WorkspaceIdSchema.parse(ws)).insert(
      { evidenceItemId: item.id, facts, model: "synthetic-seed", runId: null, promptVersion: "extract@v1" },
      tx,
    );
  });
  return { holdId, paymentId: s.paymentId, captureId: s.captureId, orderId };
}
