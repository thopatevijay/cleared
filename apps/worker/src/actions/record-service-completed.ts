// `record_service_completed` (M3-04): the secondary, seller-approved API record of a service order as
// Completed: legacy `POST /v1/shipping/trackers-batch` with status COMPLETED, no tracking number, carrier
// OTHER. PayPal support said an API equivalence with the web step is "not available", so the effect on the
// release is unconfirmed: this action NEVER touches the hold (no state move, no estimate). Only the seller's
// web-step confirmation sets the service_completed estimate (apps/web handlers/completed.ts).
// `action.execute` claims it (M2-08) and hands it here. Checks (hold-action.ts): kill switch, payload hash,
// payload, capture ownership. Then the write through our typed client (shared HTTP client + token provider).
// A 200 that lists the capture with no errors → `succeeded`, then the tracker is read back and its status
// (COMPLETED) is stored on the execution row; a 200 with errors or a 4xx → `failed`; no answer / 5xx →
// `unknown`, settled by `completedLanded` from the read-back (never by resending).
import type { JsonValue, RecordServiceCompletedPayload } from "@cleared/core";
import {
  completedBatchOutcome,
  noTrackerId,
  readBackCompleted,
  type PayPalOrdersClient,
  type ResponseMeta,
  type TrackersBatchResponse,
} from "@cleared/adapters";
import {
  appendActionAudit,
  recordExecutionOutcome,
  withTransaction,
  type ProposedActionRow,
} from "@cleared/db";
import { parseExecutablePayload } from "@cleared/core";
import { endAction } from "../jobs/action-runtime.ts";
import {
  checkHoldAction,
  failedSend,
  finish,
  sentAudit,
  type HoldActionOutcome,
  type HoldActionRun,
} from "./hold-action.ts";

export type CompletedWrites = Pick<PayPalOrdersClient, "markCompleted" | "getLegacyTracker">;

export interface CompletedRun extends HoldActionRun {
  readonly orders: CompletedWrites | undefined;
}

export async function executeRecordCompleted(run: CompletedRun): Promise<HoldActionOutcome> {
  const payload = await checkHoldAction(run, "record_service_completed");
  if (payload === null) return "failed";
  if (run.orders === undefined) {
    await finish(run, { to: "failed", code: "PAYPAL_UNAVAILABLE", debugId: null }, { error: "no orders client" });
    return "failed";
  }
  let meta: ResponseMeta | null = null;
  let batch: TrackersBatchResponse;
  try {
    batch = await run.orders.markCompleted([payload.capture_id], {
      carrier: payload.carrier,
      ...(run.writeTimeoutMs === undefined ? {} : { timeoutMs: run.writeTimeoutMs }),
      onResponse: (m) => (meta = m),
    });
  } catch (error) {
    return failedSend(run, error, "record completed");
  }
  const m = meta as ResponseMeta | null;
  const sent = { status: m?.status ?? 200, debugId: m?.debugId ?? null };
  const outcome = completedBatchOutcome(batch, payload.capture_id);
  if (!outcome.accepted) {
    await rejected(run, sent, outcome.errors);
    return "failed";
  }
  const readBack = await readBackSafely(run, payload);
  await succeeded(run, payload, sent, readBack);
  return "succeeded";
}

interface Sent {
  readonly status: number;
  readonly debugId: string | null;
}

/** The read-back after an accepted write; a failed read leaves the status unknown (the write still landed). */
async function readBackSafely(
  run: CompletedRun,
  p: RecordServiceCompletedPayload,
): Promise<{ readonly trackerStatus: string | null }> {
  if (run.orders === undefined) return { trackerStatus: null };
  try {
    return { trackerStatus: (await readBackCompleted(run.orders, p.capture_id)).status };
  } catch (error) {
    run.ctx.log.warn({ actionId: run.row.id, error: String(error) }, "completed read-back failed");
    return { trackerStatus: null };
  }
}

async function succeeded(
  run: CompletedRun,
  p: RecordServiceCompletedPayload,
  r: Sent,
  readBack: { readonly trackerStatus: string | null },
): Promise<void> {
  const { rt, row } = run;
  const response: JsonValue = {
    captureId: p.capture_id,
    trackerId: noTrackerId(p.capture_id),
    trackerStatus: readBack.trackerStatus,
  };
  await withTransaction(rt.db, async (tx) => {
    await recordExecutionOutcome(
      rt.db,
      row.workspaceId,
      row.id,
      { paypalStatus: String(r.status), paypalDebugId: r.debugId, response },
      tx,
    );
    await appendActionAudit(rt.db, sentAudit(row, { status: r.status, debugId: r.debugId }), tx);
    await appendActionAudit(
      rt.db,
      { workspaceId: row.workspaceId, actionId: row.id, actor: "system", action: "action.read_back", detail: { status: readBack.trackerStatus } },
      tx,
    );
    // no hold change: the effect of this record on the release is unconfirmed (PayPal support)
    await endAction(rt, tx, row, "executing", { to: "succeeded", debugId: r.debugId }, { debugId: r.debugId });
  });
}

/** 200 with per-tracker errors (or without the capture): PayPal refused this tracker. */
async function rejected(run: CompletedRun, r: Sent, errors: readonly string[]): Promise<void> {
  const { rt, row } = run;
  await withTransaction(rt.db, async (tx) => {
    await recordExecutionOutcome(
      rt.db,
      row.workspaceId,
      row.id,
      { paypalStatus: String(r.status), paypalDebugId: r.debugId, response: { errors: [...errors] } },
      tx,
    );
    await appendActionAudit(rt.db, sentAudit(row, { status: r.status, debugId: r.debugId, outcome: "batch_error" }), tx);
    await endAction(
      rt,
      tx,
      row,
      "executing",
      { to: "failed", code: "PAYPAL_REJECTED", debugId: r.debugId },
      { errors: [...errors] },
    );
  });
}

/**
 * Reconcile of an `unknown` write (M3-09 polls through this too): read the capture's NOTRACKER tracker
 * back; status COMPLETED → landed.
 */
export async function completedLanded(
  orders: Pick<PayPalOrdersClient, "getLegacyTracker">,
  row: ProposedActionRow,
): Promise<{ readonly landed: boolean; readonly trackerStatus: string | null }> {
  const e = parseExecutablePayload(row.kind, row.payload);
  if (e?.kind !== "record_service_completed") return { landed: false, trackerStatus: null };
  const r = await readBackCompleted(orders, e.payload.capture_id);
  return { landed: r.landed, trackerStatus: r.status };
}
