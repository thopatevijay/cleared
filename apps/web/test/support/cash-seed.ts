// M3-05 test and E2E support: one workspace's cash calendar, every event kind, from the existing seeds
// (data policy: recorded PayPal states, synthetic amounts):
// - review:    the M3-01 wallet-review hold (PENDING / PENDING_REVIEW, $64.00), estimate = seen + 24 h,
//              plus a second one in EUR (€15.50) on the same day (totals are per currency)
// - complaint: the M2-09 dispute mirror (PENDING / BUYER_COMPLAINT, $120.00, WAITING_FOR_SELLER_RESPONSE)
//              with its `dispute_hold` (PayPal gives no timeline), so it shows a reply deadline only
// - released:  a review hold PayPal released ($420.00)
// - service:   the M3-04 service hold, Completed confirmed: `filed`, `service_completed`, confirmed + 7 d
// Instants sit at 12:00 UTC, so each lands on the same day in every zone from UTC−11 to UTC+11.
import { deriveHold, fromEpochMs, WorkspaceIdSchema } from "@cleared/core";
import { forWorkspace, type Db } from "@cleared/db";
import { seedServiceHold } from "./completed-seed.ts";
import { seedDispute } from "./dispute-seed.ts";
import { seedHeldPayment } from "./hold-seed.ts";

const DAY = 86_400_000;
const noonUtc = (base: Date, days: number): Date => {
  const d = new Date(base.getTime() + days * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

export interface SeededCash {
  readonly review: { holdId: string; estimate: Date };
  readonly reviewEur: { holdId: string };
  readonly complaint: { holdId: string; disputeRowId: string; due: Date };
  readonly released: { holdId: string; at: Date };
  readonly service: { holdId: string; estimate: Date };
}

/** Every kind, at `base` + 1 (review), + 2 (released), + 3 (service), + 4 (reply due) days at 12:00 UTC. */
export async function seedCash(db: Db, ws: string, base: Date): Promise<SeededCash> {
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const review = await seedHeldPayment(db, ws, { seenAt: noonUtc(base, 0) });
  const eur = await seedHeldPayment(db, ws, { amount: "15.50", currency: "EUR", seenAt: noonUtc(base, 0) });

  const due = noonUtc(base, 4);
  const d = await seedDispute(db, ws, { dueDate: due, draft: false });
  const dh = deriveHold({
    status: "PENDING",
    reason: "BUYER_COMPLAINT",
    updateTime: fromEpochMs(base.getTime()),
  });
  if (dh === null) throw new Error("no dispute hold derived");
  const complaint = await repos.holds.insert({
    paymentId: d.paymentId,
    type: dh.type,
    reason: dh.reason,
    openedAt: new Date(dh.openedAt),
    estimatedReleaseAt: null,
    estimateSource: dh.estimateRuleId,
  });

  const at = noonUtc(base, 2);
  const gone = await seedHeldPayment(db, ws, { amount: "420.00", seenAt: noonUtc(base, -3) });
  await repos.holds.update(gone.holdId ?? "", { state: "released", releasedAt: at });

  const estimate = noonUtc(base, 3);
  const svc = await seedServiceHold(db, ws, { amount: "80.00" });
  await repos.holds.update(svc.holdId, {
    state: "filed",
    estimateSource: "service_completed",
    estimatedReleaseAt: estimate,
    completedConfirmedAt: noonUtc(base, -4),
  });
  return {
    review: { holdId: review.holdId ?? "", estimate: noonUtc(base, 1) },
    reviewEur: { holdId: eur.holdId ?? "" },
    complaint: { holdId: complaint.id, disputeRowId: d.disputeRowId, due },
    released: { holdId: gone.holdId ?? "", at },
    service: { holdId: svc.holdId, estimate },
  };
}
