// `paypal.capture.sync` (M1-04): re-fetch the capture (never trust the webhook body or event order),
// resolve its owner (ADR 0008) and mirror it into `payments`, all in the consumer's transaction.
// - owned    → claim the capture for the order's workspace (inherit), upsert the payment with
//              `applyMirror` (an older update_time changes nothing), emit `payment.captured` on first
//              insert or `payment.status_changed` on a change, mark the webhook event `processed`
// - unowned  → throw (pg-boss retries with backoff) until the 10-minute window from the event's
//              receipt has passed (covers the race with order creation), then `quarantined` + audit
// - mismatch → `quarantined` at once + audit on the owner workspace
import {
  applyMirror,
  mirroredRaw,
  resolveOwner,
  SYNC_SOURCES,
  type CaptureMirror,
  type Instant,
  type SyncSource,
  type WorkspaceId,
} from "@cleared/core";
import { reportQuarantine, type PayPalCapturesClient } from "@cleared/adapters";
import { forWorkspace, platform, type Db, type Publisher, type Tx } from "@cleared/db";
import { z } from "zod";
import type { ConsumeContext, Handler } from "../consume.ts";

export const UNOWNED_RETRY_WINDOW_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BL-01 6568286398: the sandbox app has one webhook URL (production), so a local live run's resources reach
 * production too. An unowned resource whose `custom_id` is a workspace id this database doesn't have was
 * made by another environment: still quarantined and audited, but no Sentry warning (it is expected noise,
 * and it would hide a real quarantine). A `custom_id` that is absent, not a uuid, or a workspace of this
 * database still alerts.
 */
export async function fromAnotherEnvironment(db: Db, customId: string | null, tx: Tx): Promise<boolean> {
  if (customId === null || !UUID.test(customId)) return false;
  return (await platform(db).workspaces.get(customId, tx)) === null;
}

export const CaptureSyncInputSchema = z.object({
  captureId: z.string().regex(/^[A-Z0-9]{6,32}$/),
  /** `webhook_events.id` of the delivery that caused the sync; absent for other triggers. */
  eventId: z.uuid().optional(),
  source: z.enum(SYNC_SOURCES).default("webhook"),
});
export type CaptureSyncInput = z.infer<typeof CaptureSyncInputSchema>;

export interface CaptureSyncDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly captures: Pick<PayPalCapturesClient, "getCapture">;
  readonly now: () => Date;
  readonly unownedWindowMs?: number;
}

/** Thrown while an unowned capture is still inside its retry window; pg-boss retries it. */
export class OwnerPendingError extends Error {
  override readonly name = "OwnerPendingError";
}

export type SyncOutcome = "inserted" | "changed" | "unchanged" | "stale" | "quarantined";

interface Run {
  readonly deps: CaptureSyncDeps;
  readonly tx: Tx;
  readonly input: CaptureSyncInput;
  readonly mirror: CaptureMirror;
  readonly ctx: ConsumeContext;
}

export function captureSyncHandler(deps: CaptureSyncDeps): Handler {
  return async (data, ctx) => {
    await syncCapture(deps, CaptureSyncInputSchema.parse(data), ctx);
  };
}

export async function syncCapture(
  deps: CaptureSyncDeps,
  input: CaptureSyncInput,
  ctx: ConsumeContext,
): Promise<SyncOutcome> {
  const { mirror } = await deps.captures.getCapture(input.captureId);
  const run: Run = { deps, tx: ctx.tx, input, mirror, ctx };
  const owners = platform(deps.db).resourceOwners;
  const ownerRow =
    (await owners.get("capture", mirror.captureId, ctx.tx)) ??
    (mirror.orderId === null ? null : await owners.get("order", mirror.orderId, ctx.tx));
  const owner = resolveOwner({
    customId: mirror.customId,
    ownerRow: ownerRow === null ? null : { workspaceId: ownerRow.workspaceId as WorkspaceId },
  });
  if (owner.kind === "mismatch") return quarantine(run, "custom_id_mismatch", owner.workspaceId);
  if (owner.kind === "unowned") {
    const firstSeen = await firstSeenAt(run);
    if (deps.now().getTime() - firstSeen.getTime() < (deps.unownedWindowMs ?? UNOWNED_RETRY_WINDOW_MS)) {
      throw new OwnerPendingError(`capture ${mirror.captureId} has no owner yet; retrying`);
    }
    return quarantine(run, "unowned", null);
  }
  await owners.claim(
    { resourceType: "capture", resourceId: mirror.captureId, workspaceId: owner.workspaceId },
    ctx.tx,
  );
  const outcome = await mirrorPayment(run, owner.workspaceId);
  await markEvent(run, { status: "processed", processedAt: deps.now() });
  ctx.log.info({ captureId: mirror.captureId, outcome }, "capture synced");
  return outcome;
}

async function firstSeenAt(run: Run): Promise<Date> {
  if (run.input.eventId === undefined) return run.ctx.job.createdOn;
  const row = await platform(run.deps.db).webhookEvents.get(run.input.eventId, run.tx);
  return row?.receivedAt ?? run.ctx.job.createdOn;
}

async function markEvent(
  run: Run,
  next: { status: "processed" | "quarantined"; processedAt: Date; quarantineReason?: string },
): Promise<void> {
  if (run.input.eventId === undefined) return;
  await platform(run.deps.db).webhookEvents.setStatus(run.input.eventId, next, run.tx);
}

async function quarantine(run: Run, reason: string, workspaceId: WorkspaceId | null): Promise<SyncOutcome> {
  const { mirror, input } = run;
  const foreign =
    reason === "unowned" && (await fromAnotherEnvironment(run.deps.db, mirror.customId, run.tx));
  await markEvent(run, { status: "quarantined", processedAt: run.deps.now(), quarantineReason: reason });
  await platform(run.deps.db).auth.auditSystem(
    {
      workspaceId,
      action: "paypal.capture.quarantined",
      detail: {
        reason,
        captureId: mirror.captureId,
        orderId: mirror.orderId,
        customId: mirror.customId,
        eventId: input.eventId ?? null,
        anotherEnvironment: foreign,
      },
    },
    run.tx,
  );
  const fields = { captureId: mirror.captureId, reason, workspaceId, anotherEnvironment: foreign };
  if (foreign) {
    run.ctx.log.info(fields, "capture quarantined: made by another environment");
    return "quarantined";
  }
  run.ctx.log.warn(fields, "capture quarantined");
  reportQuarantine(reason, { extra: { captureId: mirror.captureId } }); // M1-08 alert (warning)
  return "quarantined";
}

interface StoredState {
  readonly status: string;
  readonly reason: string | null;
}

async function mirrorPayment(run: Run, workspaceId: WorkspaceId): Promise<SyncOutcome> {
  const { mirror, deps, tx, input } = run;
  const repos = forWorkspace(deps.db, workspaceId);
  const payments = repos.payments;
  const prev = await payments.getByCaptureId(mirror.captureId, tx);
  const next: StoredState = {
    status: mirroredRaw(mirror.state.status),
    reason: mirror.state.reason === null ? null : mirroredRaw(mirror.state.reason),
  };
  const updateTime = mirror.updateTime ?? (deps.now().toISOString() as Instant);
  const prevRecord =
    prev?.paypalUpdatedAt == null
      ? null
      : {
          value: { status: prev.status, reason: prev.statusReason },
          updateTime: prev.paypalUpdatedAt.toISOString() as Instant,
        };
  if (!applyMirror(prevRecord, next, updateTime).ok) return "stale";
  // M3-09: the 15-minute reconcile re-reads every PENDING capture; one PayPal hasn't changed writes nothing
  if (input.source === "poll" && prev !== null && sameAsStored(prev, next, updateTime)) return "unchanged";
  const values = paymentValues(mirror, next, input.source, updateTime, deps.now());
  if (prev === null) {
    const payment = await payments.insert(values, tx);
    // M2-05 (BL-01 6536606046): the payment's proof pack (`empty`) is born with it, in the same transaction.
    await repos.proofPacks.insert({ paymentId: payment.id }, tx);
    await deps.publisher.emit(tx, {
      type: "payment.captured",
      version: 1,
      workspaceId,
      occurredAt: deps.now().toISOString() as Instant,
      data: { captureId: mirror.captureId, orderId: mirror.orderId, amount: mirror.amount, state: next },
    });
    return "inserted";
  }
  await payments.update(prev.id, values, tx);
  if (prev.status === next.status && prev.statusReason === next.reason) return "unchanged";
  await deps.publisher.emit(tx, {
    type: "payment.status_changed",
    version: 1,
    workspaceId,
    occurredAt: deps.now().toISOString() as Instant,
    data: {
      captureId: mirror.captureId,
      from: { status: prev.status, reason: prev.statusReason },
      to: next,
      source: input.source,
      updateTime,
    },
  });
  return "changed";
}

function sameAsStored(
  prev: { status: string; statusReason: string | null; paypalUpdatedAt: Date | null },
  next: StoredState,
  updateTime: Instant,
): boolean {
  return (
    prev.status === next.status &&
    prev.statusReason === next.reason &&
    prev.paypalUpdatedAt?.getTime() === Date.parse(updateTime)
  );
}

function paymentValues(m: CaptureMirror, s: StoredState, source: SyncSource, updateTime: Instant, now: Date) {
  return {
    captureId: m.captureId,
    orderId: m.orderId,
    amount: m.amount.amount,
    currency: m.amount.currency,
    receivableAmount: m.receivable?.amount ?? null,
    receivableCurrency: m.receivable?.currency ?? null,
    status: s.status,
    statusReason: s.reason,
    source,
    paypalUpdatedAt: new Date(updateTime),
    syncedAt: now,
  };
}
