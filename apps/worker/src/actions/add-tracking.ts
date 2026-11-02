// `add_tracking` (M3-03): the one approved tracking write. Goods-tracking automation is PayPal's own
// product; this is one seller-approved tracker on one capture. `action.execute` claims the action (M2-08)
// and hands it here. Checks, each with an audit row: kill switch, payload hash (the approval's sha256),
// ownership of the capture. Then `POST /v2/checkout/orders/{id}/track` through our typed PayPal client
// with PayPal-Request-Id = the action id. 2xx → `succeeded` + the execution row (status, paypal-debug-id) +
// the hold walked to `filed` with the goods_delivered estimate and no date; 4xx → `failed`; no answer /
// 5xx → `unknown`, settled by `reconcileTracking` from the order's trackers (never by resending).
import {
  canonicalHash,
  checkKillSwitch,
  checkOwnership,
  checkPayloadHash,
  classifySendFailure,
  parseExecutablePayload,
  RECONCILE_FIRST_DELAY_SECONDS,
  transitionHold,
  WorkspaceIdSchema,
  type AddTrackingPayload,
  type HoldEvent,
  type HoldState,
  type JsonValue,
} from "@cleared/core";
import { trackerFor, type Order, type PayPalOrdersClient, type ResponseMeta } from "@cleared/adapters";
import {
  appendActionAudit,
  approvalForAction,
  forWorkspace,
  holdsRepo,
  platform,
  recordExecutionOutcome,
  withTransaction,
  type Db,
  type ProposedActionRow,
  type Tx,
} from "@cleared/db";
import { HttpStatusError } from "@cleared/adapters";
import { endAction, enqueueReconcile, type ActionRuntime, type Ending } from "../jobs/action-runtime.ts";
import type { ConsumeContext } from "../consume.ts";
import { sendFailureOf } from "../jobs/execute-action.ts";

export type TrackingWrites = Pick<PayPalOrdersClient, "trackOrder" | "getOrder">;

export interface TrackingRun {
  readonly rt: ActionRuntime;
  readonly orders: TrackingWrites | undefined;
  readonly killSwitch: () => Promise<boolean>;
  readonly writeTimeoutMs?: number;
  readonly row: ProposedActionRow;
  readonly ctx: ConsumeContext;
}

export type TrackingOutcome = "succeeded" | "failed" | "unknown";

/** Reconcile compares nothing from before the send: the tracker's presence settles it. */
export const NO_SNAPSHOT = { status: "", allowedActions: [] as string[], sellerSubmissions: null };

async function audit(run: TrackingRun, action: string, detail: Record<string, JsonValue>): Promise<void> {
  const { row } = run;
  await appendActionAudit(run.rt.db, {
    workspaceId: row.workspaceId,
    actionId: row.id,
    actor: "system",
    action,
    detail,
  });
}

async function finish(run: TrackingRun, end: Ending, detail: Record<string, JsonValue> = {}) {
  await withTransaction(run.rt.db, (tx) => endAction(run.rt, tx, run.row, "executing", end, detail));
}

async function passes(
  run: TrackingRun,
  r: ReturnType<typeof checkKillSwitch>,
  extra: Record<string, JsonValue> = {},
): Promise<boolean> {
  await audit(run, "action.check", { check: r.check, ok: r.ok, ...(r.ok ? {} : { code: r.code }), ...extra });
  if (!r.ok) await finish(run, { to: "failed", code: r.code, debugId: null });
  return r.ok;
}

/** The checks in order; the payload to send, or null when the action already ended `failed`. */
async function check(run: TrackingRun): Promise<AddTrackingPayload | null> {
  const { rt, row } = run;
  if (!(await passes(run, checkKillSwitch(await run.killSwitch())))) return null;
  const approval = await approvalForAction(rt.db, row.workspaceId, row.id);
  const recomputed = canonicalHash(row.payload as JsonValue);
  const hash = checkPayloadHash({
    recomputed,
    approved: approval?.payloadSha256 ?? "",
    stored: row.payloadSha256,
  });
  if (!(await passes(run, hash, { recomputed }))) return null;
  const e = parseExecutablePayload(row.kind, row.payload);
  if (e?.kind !== "add_tracking") {
    await finish(run, { to: "failed", code: "INVALID_PAYLOAD", debugId: null });
    return null;
  }
  const owner = await platform(rt.db).resourceOwners.get("capture", e.payload.capture_id);
  const owned = checkOwnership({
    actionWorkspaceId: row.workspaceId,
    ownerWorkspaceId: owner?.workspaceId ?? null,
  });
  if (!(await passes(run, owned, { captureId: e.payload.capture_id }))) return null;
  return e.payload;
}

export async function executeTracking(run: TrackingRun): Promise<TrackingOutcome> {
  const payload = await check(run);
  if (payload === null) return "failed";
  if (run.orders === undefined) {
    await finish(
      run,
      { to: "failed", code: "PAYPAL_UNAVAILABLE", debugId: null },
      { error: "no orders client" },
    );
    return "failed";
  }
  let meta: ResponseMeta | null = null;
  try {
    const order = await run.orders.trackOrder(payload.order_id, {
      captureId: payload.capture_id,
      trackingNumber: payload.tracking_number,
      carrier: payload.carrier,
      ...(payload.carrier_name_other === undefined ? {} : { carrierNameOther: payload.carrier_name_other }),
      notifyPayer: payload.notify_payer,
      requestId: run.row.id,
      ...(run.writeTimeoutMs === undefined ? {} : { timeoutMs: run.writeTimeoutMs }),
      onResponse: (m) => (meta = m),
    });
    const m = meta as ResponseMeta | null;
    await succeeded(run, payload, { status: m?.status ?? 201, debugId: m?.debugId ?? null, order });
    return "succeeded";
  } catch (error) {
    return failedSend(run, error);
  }
}

function trackerSummary(order: Order, p: AddTrackingPayload): JsonValue {
  const t = trackerOf(order, p);
  return { orderId: order.id, trackerId: t?.id ?? null, trackerStatus: t?.status ?? null };
}

const trackerOf = (order: Order, p: Pick<AddTrackingPayload, "capture_id" | "tracking_number">) =>
  trackerFor(order, p.capture_id, p.tracking_number);

async function succeeded(
  run: TrackingRun,
  p: AddTrackingPayload,
  r: { readonly status: number; readonly debugId: string | null; readonly order: Order },
): Promise<void> {
  const { rt, row } = run;
  await withTransaction(rt.db, async (tx) => {
    const response = trackerSummary(r.order, p);
    await recordExecutionOutcome(
      rt.db,
      row.workspaceId,
      row.id,
      { paypalStatus: String(r.status), paypalDebugId: r.debugId, response },
      tx,
    );
    await appendActionAudit(rt.db, sentAudit(row, { status: r.status, debugId: r.debugId }), tx);
    await endAction(
      rt,
      tx,
      row,
      "executing",
      { to: "succeeded", debugId: r.debugId },
      { debugId: r.debugId },
    );
    await fileHold(rt.db, row.workspaceId, p.capture_id, tx);
  });
}

function sentAudit(row: ProposedActionRow, detail: Record<string, JsonValue>) {
  return {
    workspaceId: row.workspaceId,
    actionId: row.id,
    actor: "system" as const,
    action: "action.sent",
    detail: { requestId: row.id, ...detail },
  };
}

const TO_FILED: readonly HoldEvent[] = ["action_proposed", "action_approved", "action_filed"];

/**
 * The capture's active hold → `filed` (ADR 0017 addendum): each of proposed → approved → filed the current
 * state takes, through `transitionHold`. A goods hold's estimate becomes `goods_delivered` with no date
 * (PayPal's 24 h counts from the courier's delivery confirmation, which Cleared does not know yet).
 */
export async function fileHold(db: Db, ws: string, captureId: string, tx: Tx): Promise<HoldState | null> {
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const payment = await repos.payments.getByCaptureId(captureId, tx);
  if (payment === null) return null;
  const holds = holdsRepo(db, ws);
  await holds.lockPayment(payment.id, tx);
  const hold = await holds.activeFor(payment.id, tx);
  if (hold === null) return null;
  let state: HoldState = hold.state;
  for (const ev of TO_FILED) {
    const next = transitionHold(state, ev);
    if (next.ok) state = next.value;
  }
  if (state === hold.state) return state;
  const estimate =
    hold.type === "goods" ? { estimateSource: "goods_delivered", estimatedReleaseAt: null } : {};
  await repos.holds.update(hold.id, { state, ...estimate }, tx);
  return state;
}

async function failedSend(run: TrackingRun, error: unknown): Promise<TrackingOutcome> {
  const { rt, row } = run;
  const f = sendFailureOf(error);
  const outcome = classifySendFailure(f);
  const status = f.kind === "status" ? f.status : null;
  const debugId = error instanceof HttpStatusError ? (error.debugId ?? null) : null;
  run.ctx.log.warn(
    { actionId: row.id, failure: f.kind, status, debugId, error: String(error) },
    "tracking send failed",
  );
  await withTransaction(rt.db, async (tx) => {
    if (f.kind === "status" || f.kind === "no_answer") {
      const body = error instanceof HttpStatusError ? { body: error.bodyText.slice(0, 4000) } : null;
      await recordExecutionOutcome(
        rt.db,
        row.workspaceId,
        row.id,
        { paypalStatus: status === null ? null : String(status), paypalDebugId: debugId, response: body },
        tx,
      );
      await appendActionAudit(rt.db, sentAudit(row, { status, debugId, outcome: f.kind }), tx);
    }
    if (outcome.next === "failed") {
      await endAction(
        rt,
        tx,
        row,
        "executing",
        { to: "failed", code: outcome.code, debugId },
        { failure: f.kind },
      );
      return;
    }
    await endAction(rt, tx, row, "executing", { to: "unknown" }, { failure: f.kind });
    const input = { actionId: row.id, workspaceId: row.workspaceId, attempt: 1, before: NO_SNAPSHOT };
    await enqueueReconcile(rt, tx, input, RECONCILE_FIRST_DELAY_SECONDS);
  });
  return outcome.next;
}

/**
 * Reconcile of an `unknown` tracking write (M3-09 polls through this too): re-read the order; the tracker
 * for this capture + tracking number is there → landed. In the caller's transaction.
 */
export async function trackingLanded(
  orders: Pick<PayPalOrdersClient, "getOrder">,
  row: ProposedActionRow,
): Promise<{ readonly landed: boolean; readonly trackerStatus: string | null }> {
  const e = parseExecutablePayload(row.kind, row.payload);
  if (e?.kind !== "add_tracking") return { landed: false, trackerStatus: null };
  const order = await orders.getOrder(e.payload.order_id);
  const t = trackerOf(order, e.payload);
  return { landed: t !== null, trackerStatus: t?.status ?? null };
}

/** After a reconcile finds the tracker: the hold moves exactly as on a direct success. */
export async function onTrackingReconciled(db: Db, row: ProposedActionRow, tx: Tx): Promise<void> {
  const e = parseExecutablePayload(row.kind, row.payload);
  if (e?.kind === "add_tracking") await fileHold(db, row.workspaceId, e.payload.capture_id, tx);
}
