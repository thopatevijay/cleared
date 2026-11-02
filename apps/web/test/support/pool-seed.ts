// M3-10 test support: a held review-hold pool row as `pool:capture` and the M3-01 path leave it: the pool
// workspace owns the order and the capture, the payment is mirrored PENDING / PENDING_REVIEW (the recorded
// wallet-review capture, via `seedHeldPayment`) and its hold is derived.
import { randomBytes } from "node:crypto";
import { platform, type Db } from "@cleared/db";
import { seedHeldPayment } from "./hold-seed.ts";

export interface SeededPoolHold {
  readonly poolWorkspaceId: string;
  readonly poolId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly paymentId: string;
}

export async function seedPoolHold(
  db: Db,
  o: { readonly capturedAt: Date; readonly purpose?: "judge" | "video" },
): Promise<SeededPoolHold> {
  const p = platform(db);
  const pool = await p.workspaces.create({
    kind: "seller",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
    llmBudgetUsd: "0",
  });
  const held = await seedHeldPayment(db, pool.id, { seenAt: o.capturedAt });
  const orderId = `E2EO${randomBytes(6).toString("hex").toUpperCase()}`;
  await p.resourceOwners.claim({ resourceType: "order", resourceId: orderId, workspaceId: pool.id });
  const row = await p.reviewHoldPool.insert({
    orderId,
    poolWorkspaceId: pool.id,
    purpose: o.purpose ?? "judge",
    amount: "64.00",
    currency: "USD",
    approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
  });
  await p.reviewHoldPool.markCaptured(row.id, {
    captureId: held.captureId,
    captureStatus: "PENDING",
    captureReason: "PENDING_REVIEW",
    capturedAt: o.capturedAt,
    state: "held",
  });
  return {
    poolWorkspaceId: pool.id,
    poolId: row.id,
    orderId,
    captureId: held.captureId,
    paymentId: held.paymentId,
  };
}
