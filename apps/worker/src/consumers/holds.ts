// M3-01 holds consumer (ADR 0017): on `payment.captured`, `payment.status_changed` and `dispute.opened`,
// re-derive the payment's hold from the mirrored capture (capture sync already re-fetched it from PayPal;
// the event only says which payment to look at, never what its state is). Under a lock on the payment
// row, in the delivery's one transaction:
//   derived, no active hold      → insert the hold (`open`) + `hold.opened`
//   capture left PENDING, active → `released` (machine edge `capture_released`) + `hold.released`
//   derived, other reason        → the active hold takes the new reason/rule (no event)
// Anything else changes nothing, so a replay (or the same event twice) writes nothing.
import {
  CaptureIdSchema,
  deriveHold,
  DomainEventSchema,
  fromEpochMs,
  HoldIdSchema,
  transitionHold,
  type DerivedHold,
  type Instant,
  type WorkspaceId,
} from "@cleared/core";
import {
  forWorkspace,
  holdsRepo,
  type Db,
  type HoldRow,
  type PaymentRowForHold,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface HoldsDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly now: () => Date;
}

export type HoldOutcome = "opened" | "released" | "updated" | "unchanged" | "no_payment";

const instant = (d: Date): Instant => fromEpochMs(d.getTime());
const asDate = (i: Instant | null): Date | null => (i === null ? null : new Date(i));

export function holdsHandler(deps: HoldsDeps): Handler {
  return async (data, ctx) => {
    await holdsForEvent(deps, data, ctx);
  };
}

/** The payment an event points at (id null when it isn't mirrored in the event's workspace). */
async function paymentFor(
  deps: HoldsDeps,
  data: unknown,
  tx: Tx,
): Promise<{ ws: WorkspaceId; id: string | null }> {
  const e = DomainEventSchema.parse(data);
  const repos = forWorkspace(deps.db, e.workspaceId);
  switch (e.type) {
    case "payment.captured":
    case "payment.status_changed": {
      const p = await repos.payments.getByCaptureId(e.data.captureId, tx);
      return { ws: e.workspaceId, id: p?.id ?? null };
    }
    case "dispute.opened": {
      const d = await repos.disputes.getByDisputeId(e.data.disputeId, tx);
      return { ws: e.workspaceId, id: d?.paymentId ?? null };
    }
    default:
      throw new Error(`holds: unexpected event ${e.type}`);
  }
}

export async function holdsForEvent(
  deps: HoldsDeps,
  data: unknown,
  ctx: ConsumeContext,
): Promise<HoldOutcome> {
  const { ws, id } = await paymentFor(deps, data, ctx.tx);
  const outcome = id === null ? "no_payment" : await reconcileHold(deps, ws, id, ctx.tx);
  ctx.log.info({ paymentId: id, outcome }, "hold reconciled");
  return outcome;
}

interface Run {
  readonly deps: HoldsDeps;
  readonly ws: WorkspaceId;
  readonly tx: Tx;
  readonly payment: PaymentRowForHold;
  /** PayPal's update_time of the mirrored capture (else when Cleared synced it) */
  readonly seenAt: Instant;
}

async function derive(r: Run): Promise<DerivedHold | null> {
  const dispute = await holdsRepo(r.deps.db, r.ws).disputeFor(r.payment.id, r.tx);
  const due = dispute?.sellerResponseDueDate ?? null;
  return deriveHold(
    { status: r.payment.status, reason: r.payment.statusReason, updateTime: r.seenAt },
    dispute === null
      ? null
      : {
          disputeId: dispute.disputeId,
          status: dispute.status,
          sellerResponseDueDate: due === null ? null : instant(due),
        },
  );
}

async function openHold(r: Run, d: DerivedHold): Promise<HoldOutcome> {
  const row = await forWorkspace(r.deps.db, r.ws).holds.insert(
    {
      paymentId: r.payment.id,
      state: "open",
      type: d.type,
      reason: d.reason,
      openedAt: new Date(d.openedAt),
      estimatedReleaseAt: asDate(d.estimatedReleaseAt),
      estimateSource: d.estimateRuleId,
    },
    r.tx,
  );
  await r.deps.publisher.emit(r.tx, {
    type: "hold.opened",
    version: 1,
    workspaceId: r.ws,
    occurredAt: instant(r.deps.now()),
    data: {
      holdId: HoldIdSchema.parse(row.id),
      captureId: CaptureIdSchema.parse(r.payment.captureId),
      reason: d.reason,
    },
  });
  return "opened";
}

async function releaseHold(r: Run, current: HoldRow): Promise<HoldOutcome> {
  const next = transitionHold(current.state, "capture_released");
  if (!next.ok) return "unchanged";
  await forWorkspace(r.deps.db, r.ws).holds.update(
    current.id,
    { state: next.value, releasedAt: new Date(r.seenAt) },
    r.tx,
  );
  await r.deps.publisher.emit(r.tx, {
    type: "hold.released",
    version: 1,
    workspaceId: r.ws,
    occurredAt: instant(r.deps.now()),
    data: {
      holdId: HoldIdSchema.parse(current.id),
      captureId: CaptureIdSchema.parse(r.payment.captureId),
      releasedAt: r.seenAt,
    },
  });
  return "released";
}

async function retarget(r: Run, current: HoldRow, d: DerivedHold): Promise<HoldOutcome> {
  await forWorkspace(r.deps.db, r.ws).holds.update(
    current.id,
    {
      type: d.type,
      reason: d.reason,
      estimatedReleaseAt: asDate(d.estimatedReleaseAt),
      estimateSource: d.estimateRuleId,
    },
    r.tx,
  );
  return "updated";
}

/** Reconciles one payment's hold with its mirrored capture (see the header). */
export async function reconcileHold(
  deps: HoldsDeps,
  ws: WorkspaceId,
  paymentId: string,
  tx: Tx,
): Promise<HoldOutcome> {
  const holds = holdsRepo(deps.db, ws);
  const payment = await holds.lockPayment(paymentId, tx);
  if (payment === null) return "no_payment";
  const r: Run = { deps, ws, tx, payment, seenAt: instant(payment.paypalUpdatedAt ?? payment.syncedAt) };
  const derived = await derive(r);
  const current = await holds.activeFor(paymentId, tx);
  if (current === null) return derived === null ? "unchanged" : openHold(r, derived);
  // released only once PayPal says the capture left PENDING (PENDING without a reason is still held)
  if (derived === null) return payment.status === "PENDING" ? "unchanged" : releaseHold(r, current);
  return derived.reason === current.reason ? "unchanged" : retarget(r, current, derived);
}
