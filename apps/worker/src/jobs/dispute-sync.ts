// `paypal.dispute.sync` (M2-06): re-fetch the dispute (never trust the webhook body or event order) and
// mirror it into `disputes`, all in the consumer's transaction.
// - owner: the dispute's own `paypal_resource_owner` row, else the disputed capture's (inherited, ADR
//   0008), then claimed for the dispute. No owner → retry inside the 10-minute window (the capture may
//   not be claimed yet), then quarantine: no `disputes` row, the event `quarantined`, an audit entry and
//   a Sentry warning. A `custom` that disagrees with the owner → quarantine at once.
// - mirror: `applyMirror` on PayPal's `update_time` (an older one never overwrites a newer one); a first
//   insert emits `dispute.opened`, a status change `dispute.status_changed` (version 1), same tx.
// - then: the deadline position (state + one-time alert), and on any change a capture re-sync, so the
//   linked hold (PENDING / BUYER_COMPLAINT) appears.
// Targeted use (M2-10's scenario poll, M2-08 after an execution): enqueue `{disputeId, source: "poll"}`.
import {
  applyMirror,
  mapDispute,
  mirroredRaw,
  resolveOwner,
  SYNC_SOURCES,
  type DisputeMirror,
  type Instant,
  type WorkspaceId,
} from "@cleared/core";
import { reportQuarantine, type PayPalDisputesClient } from "@cleared/adapters";
import {
  forWorkspace,
  PAYPAL_CAPTURE_SYNC_QUEUE,
  platform,
  type Db,
  type DisputeRow,
  type Publisher,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import type { ConsumeContext, Handler } from "../consume.ts";
import { OwnerPendingError, UNOWNED_RETRY_WINDOW_MS } from "./capture-sync.ts";
import { applyDeadline } from "./deadline-watcher.ts";

export const DisputeSyncInputSchema = z.object({
  disputeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
  /** `webhook_events.id` of the delivery that caused the sync; absent for targeted syncs. */
  eventId: z.uuid().optional(),
  source: z.enum(SYNC_SOURCES).default("webhook"),
});
export type DisputeSyncInput = z.infer<typeof DisputeSyncInputSchema>;

export interface DisputeSyncDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly disputes: Pick<PayPalDisputesClient, "getDispute">;
  readonly now: () => Date;
  readonly unownedWindowMs?: number;
}

export type DisputeSyncOutcome = "inserted" | "changed" | "unchanged" | "stale" | "quarantined";

interface Run {
  readonly deps: DisputeSyncDeps;
  readonly tx: Tx;
  readonly input: DisputeSyncInput;
  readonly mirror: DisputeMirror;
  readonly ctx: ConsumeContext;
}

export function disputeSyncHandler(deps: DisputeSyncDeps): Handler {
  return async (data, ctx) => {
    await syncDispute(deps, DisputeSyncInputSchema.parse(data), ctx);
  };
}

export async function syncDispute(
  deps: DisputeSyncDeps,
  input: DisputeSyncInput,
  ctx: ConsumeContext,
): Promise<DisputeSyncOutcome> {
  const mapped = mapDispute(await deps.disputes.getDispute(input.disputeId));
  if (!mapped.ok) throw new Error(`dispute ${input.disputeId}: ${mapped.error.message}`);
  const run: Run = { deps, tx: ctx.tx, input, mirror: mapped.value, ctx };
  const workspaceId = await ownerOf(run);
  if (workspaceId === null) return "quarantined";
  const outcome = await mirrorDispute(run, workspaceId);
  await markEvent(run, { status: "processed", processedAt: deps.now() });
  ctx.log.info({ disputeId: run.mirror.disputeId, outcome }, "dispute synced");
  return outcome;
}

/** The owning workspace (claimed for the dispute), or null once quarantined. Throws while pending. */
async function ownerOf(run: Run): Promise<WorkspaceId | null> {
  const { mirror, deps, tx } = run;
  const owners = platform(deps.db).resourceOwners;
  const ownerRow =
    (await owners.get("dispute", mirror.disputeId, tx)) ??
    (mirror.captureId === null ? null : await owners.get("capture", mirror.captureId, tx));
  const owner = resolveOwner({
    customId: mirror.customId,
    ownerRow: ownerRow === null ? null : { workspaceId: ownerRow.workspaceId as WorkspaceId },
  });
  if (owner.kind === "mismatch") return quarantine(run, "custom_id_mismatch", owner.workspaceId);
  if (owner.kind === "unowned") {
    const firstSeen = await firstSeenAt(run);
    if (deps.now().getTime() - firstSeen.getTime() < (deps.unownedWindowMs ?? UNOWNED_RETRY_WINDOW_MS)) {
      throw new OwnerPendingError(`dispute ${mirror.disputeId}: its capture has no owner yet; retrying`);
    }
    return quarantine(run, "unowned", null);
  }
  await owners.claim(
    { resourceType: "dispute", resourceId: mirror.disputeId, workspaceId: owner.workspaceId },
    tx,
  );
  return owner.workspaceId;
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

async function quarantine(run: Run, reason: string, workspaceId: WorkspaceId | null): Promise<null> {
  const { mirror, input } = run;
  await markEvent(run, { status: "quarantined", processedAt: run.deps.now(), quarantineReason: reason });
  await platform(run.deps.db).auth.auditSystem(
    {
      workspaceId,
      action: "paypal.dispute.quarantined",
      detail: {
        reason,
        disputeId: mirror.disputeId,
        captureId: mirror.captureId,
        customId: mirror.customId,
        eventId: input.eventId ?? null,
      },
    },
    run.tx,
  );
  run.ctx.log.warn({ disputeId: mirror.disputeId, reason, workspaceId }, "dispute quarantined");
  reportQuarantine(`dispute ${reason}`, { extra: { disputeId: mirror.disputeId } }); // M1-08 alert
  return null;
}

/** The columns the mirror owns (everything PayPal reports, plus the link to our payment). */
function mirrorValues(m: DisputeMirror, paymentId: string | null, now: Date) {
  return {
    disputeId: m.disputeId,
    paymentId,
    reason: m.reason,
    stage: m.state.stage === null ? null : mirroredRaw(m.state.stage),
    status: mirroredRaw(m.state.status),
    sellerResponseDueDate: m.sellerResponseDueDate === null ? null : new Date(m.sellerResponseDueDate),
    outcome: m.outcome,
    allowedActions: [...m.allowedActions],
    paypalUpdatedAt: new Date(m.updateTime),
    syncedAt: now,
  };
}

type MirrorValues = ReturnType<typeof mirrorValues>;

/** Whether the stored row already says what PayPal says (syncedAt aside). */
function sameMirror(prev: DisputeRow, next: MirrorValues): boolean {
  const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
  return (
    prev.paymentId === next.paymentId &&
    prev.reason === next.reason &&
    prev.stage === next.stage &&
    prev.status === next.status &&
    iso(prev.sellerResponseDueDate) === iso(next.sellerResponseDueDate) &&
    JSON.stringify(prev.outcome) === JSON.stringify(next.outcome) &&
    JSON.stringify(prev.allowedActions) === JSON.stringify(next.allowedActions) &&
    iso(prev.paypalUpdatedAt) === iso(next.paypalUpdatedAt)
  );
}

async function mirrorDispute(run: Run, workspaceId: WorkspaceId): Promise<DisputeSyncOutcome> {
  const { mirror, deps, tx } = run;
  const ws = forWorkspace(deps.db, workspaceId);
  const prev = await ws.disputes.getByDisputeId(mirror.disputeId, tx);
  const prevRecord =
    prev?.paypalUpdatedAt == null
      ? null
      : { value: prev.status, updateTime: prev.paypalUpdatedAt.toISOString() as Instant };
  if (!applyMirror(prevRecord, mirroredRaw(mirror.state.status), mirror.updateTime).ok) return "stale";
  const payment = mirror.captureId === null ? null : await ws.payments.getByCaptureId(mirror.captureId, tx);
  const values = mirrorValues(mirror, payment?.id ?? prev?.paymentId ?? null, deps.now());
  const occurredAt = deps.now().toISOString() as Instant;
  let outcome: DisputeSyncOutcome;
  let row: DisputeRow;
  if (prev === null) {
    row = await ws.disputes.insert(values, tx);
    await deps.publisher.emit(tx, {
      type: "dispute.opened",
      version: 1,
      workspaceId,
      occurredAt,
      data: {
        disputeId: mirror.disputeId,
        captureId: mirror.captureId,
        status: values.status,
        sellerResponseDueDate: mirror.sellerResponseDueDate,
      },
    });
    outcome = "inserted";
  } else {
    outcome = sameMirror(prev, values) ? "unchanged" : "changed";
    row = (await ws.disputes.update(prev.id, values, tx)) ?? prev;
    if (prev.status !== values.status) {
      await deps.publisher.emit(tx, {
        type: "dispute.status_changed",
        version: 1,
        workspaceId,
        occurredAt,
        data: {
          disputeId: mirror.disputeId,
          from: prev.status,
          to: values.status,
          source: run.input.source,
          updateTime: mirror.updateTime,
        },
      });
    }
  }
  await applyDeadline(deps.db, row, deps.now(), tx);
  if (outcome !== "unchanged" && mirror.captureId !== null) {
    await deps.publisher.enqueue(
      tx,
      PAYPAL_CAPTURE_SYNC_QUEUE,
      { captureId: mirror.captureId, source: run.input.source },
      { workspaceId },
    );
  }
  return outcome;
}
