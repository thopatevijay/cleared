// M3-01 test and E2E support: a held payment in a workspace, from the recorded wallet-review capture
// (fixtures/paypal/captures/pending-review.json: PENDING / PENDING_REVIEW, seen 2026-10-26T11:24:21Z) with
// the synthetic demo amount ($64.00 USD; the spike recorded none, PROVENANCE.md).
// - with a publisher (E2E): the payment row, its owner claim and `payment.captured` commit in one
//   transaction, and the running worker's holds consumer derives the hold (the product path)
// - without one (API tests, no worker): the hold row is written from core's `deriveHold` directly
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CaptureIdSchema, deriveHold, fromEpochMs, MoneySchema, type WorkspaceId } from "@cleared/core";
import { forWorkspace, platform, withTransaction, type Db, type Publisher } from "@cleared/db";

const FIXTURE = new URL("../../../../fixtures/paypal/captures/pending-review.json", import.meta.url);

interface Recorded {
  capture_status: string;
  status_details: { reason: string };
}

export interface HeldPaymentOptions {
  readonly amount?: string;
  readonly currency?: string;
  /** PayPal's update time of the PENDING capture (default: the recorded create_time) */
  readonly seenAt?: Date;
  /** false: the capture is not claimed by this workspace (an unowned capture) */
  readonly owned?: boolean;
  readonly status?: string;
  readonly reason?: string | null;
}

export interface SeededHold {
  readonly captureId: string;
  readonly paymentId: string;
  /** null until the worker derives it (publisher path) */
  readonly holdId: string | null;
}

export function recordedReview(): Recorded {
  const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as { response: { body: Recorded } };
  return f.response.body;
}

export async function seedHeldPayment(
  db: Db,
  ws: string,
  o: HeldPaymentOptions = {},
  publisher?: Publisher,
): Promise<SeededHold> {
  const rec = recordedReview();
  const captureId = `E2EH${randomBytes(6).toString("hex").toUpperCase()}`;
  const seenAt = o.seenAt ?? new Date("2026-10-26T11:24:21Z");
  const status = o.status ?? rec.capture_status;
  const reason = o.reason === undefined ? rec.status_details.reason : o.reason;
  const amount = o.amount ?? "64.00";
  const currency = o.currency ?? "USD";
  const repos = forWorkspace(db, ws as WorkspaceId);
  return withTransaction(db, async (tx) => {
    if (o.owned !== false) {
      await platform(db).resourceOwners.claim(
        { resourceType: "capture", resourceId: captureId, workspaceId: ws },
        tx,
      );
    }
    const p = await repos.payments.insert(
      {
        captureId,
        amount,
        currency,
        status,
        statusReason: reason,
        source: "webhook",
        paypalUpdatedAt: seenAt,
      },
      tx,
    );
    await repos.proofPacks.insert({ paymentId: p.id }, tx);
    if (publisher !== undefined) {
      await publisher.emit(tx, {
        type: "payment.captured",
        version: 1,
        workspaceId: ws as WorkspaceId,
        occurredAt: fromEpochMs(Date.now()),
        data: {
          captureId: CaptureIdSchema.parse(captureId),
          orderId: null,
          amount: MoneySchema.parse({ amount, currency }),
          state: { status, reason },
        },
      });
      return { captureId, paymentId: p.id, holdId: null };
    }
    const d = deriveHold({ status, reason, updateTime: fromEpochMs(seenAt.getTime()) });
    if (d === null) return { captureId, paymentId: p.id, holdId: null };
    const h = await repos.holds.insert(
      {
        paymentId: p.id,
        type: d.type,
        reason: d.reason,
        openedAt: new Date(d.openedAt),
        estimatedReleaseAt: d.estimatedReleaseAt === null ? null : new Date(d.estimatedReleaseAt),
        estimateSource: d.estimateRuleId,
      },
      tx,
    );
    return { captureId, paymentId: p.id, holdId: h.id };
  });
}
