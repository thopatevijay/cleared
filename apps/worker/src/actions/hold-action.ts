// The governed steps a hold action (a write on a capture, not a dispute) shares: `add_tracking` (M3-03) and
// `record_service_completed` (M3-04). `action.execute` claims the action (M2-08) first. Checks, each with an
// audit row: kill switch, payload hash (the approval's sha256), a valid payload of the kind, ownership of the
// capture. A send failure is classified once: 4xx → `failed`; no answer / 5xx → `unknown` + a reconcile job
// that settles it from PayPal's own state (never by resending).
import {
  canonicalHash,
  checkKillSwitch,
  checkOwnership,
  checkPayloadHash,
  classifySendFailure,
  parseExecutablePayload,
  RECONCILE_FIRST_DELAY_SECONDS,
  type AddTrackingPayload,
  type HoldActionKind,
  type JsonValue,
  type RecordServiceCompletedPayload,
} from "@cleared/core";
import { HttpStatusError } from "@cleared/adapters";
import {
  appendActionAudit,
  approvalForAction,
  platform,
  recordExecutionOutcome,
  withTransaction,
  type ProposedActionRow,
} from "@cleared/db";
import { endAction, enqueueReconcile, type ActionRuntime, type Ending } from "../jobs/action-runtime.ts";
import type { ConsumeContext } from "../consume.ts";
import { sendFailureOf } from "../jobs/execute-action.ts";

export interface HoldActionRun {
  readonly rt: ActionRuntime;
  readonly killSwitch: () => Promise<boolean>;
  readonly writeTimeoutMs?: number;
  readonly row: ProposedActionRow;
  readonly ctx: ConsumeContext;
}

export type HoldActionOutcome = "succeeded" | "failed" | "unknown";

/** Reconcile compares nothing from before the send: PayPal's own record settles it. */
export const NO_SNAPSHOT = { status: "", allowedActions: [] as string[], sellerSubmissions: null };

async function audit(run: HoldActionRun, action: string, detail: Record<string, JsonValue>): Promise<void> {
  const { row } = run;
  await appendActionAudit(run.rt.db, {
    workspaceId: row.workspaceId,
    actionId: row.id,
    actor: "system",
    action,
    detail,
  });
}

export async function finish(run: HoldActionRun, end: Ending, detail: Record<string, JsonValue> = {}) {
  await withTransaction(run.rt.db, (tx) => endAction(run.rt, tx, run.row, "executing", end, detail));
}

async function passes(
  run: HoldActionRun,
  r: ReturnType<typeof checkKillSwitch>,
  extra: Record<string, JsonValue> = {},
): Promise<boolean> {
  await audit(run, "action.check", { check: r.check, ok: r.ok, ...(r.ok ? {} : { code: r.code }), ...extra });
  if (!r.ok) await finish(run, { to: "failed", code: r.code, debugId: null });
  return r.ok;
}

interface HoldPayloads {
  readonly add_tracking: AddTrackingPayload;
  readonly record_service_completed: RecordServiceCompletedPayload;
}
type PayloadOf<K extends HoldActionKind> = HoldPayloads[K];

/** The checks in order; the payload to send, or null when the action already ended `failed`. */
export async function checkHoldAction<K extends HoldActionKind>(
  run: HoldActionRun,
  kind: K,
): Promise<PayloadOf<K> | null> {
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
  if (e?.kind !== kind) {
    await finish(run, { to: "failed", code: "INVALID_PAYLOAD", debugId: null });
    return null;
  }
  const payload = e.payload as PayloadOf<K>;
  const captureId = payload.capture_id;
  const owner = await platform(rt.db).resourceOwners.get("capture", captureId);
  const owned = checkOwnership({
    actionWorkspaceId: row.workspaceId,
    ownerWorkspaceId: owner?.workspaceId ?? null,
  });
  if (!(await passes(run, owned, { captureId }))) return null;
  return payload;
}

export function sentAudit(row: ProposedActionRow, detail: Record<string, JsonValue>) {
  return {
    workspaceId: row.workspaceId,
    actionId: row.id,
    actor: "system" as const,
    action: "action.sent",
    detail: { requestId: row.id, ...detail },
  };
}

/** A send that threw: 4xx → `failed`; no answer / 5xx → `unknown` + `action.reconcile`. */
export async function failedSend(
  run: HoldActionRun,
  error: unknown,
  label: string,
): Promise<HoldActionOutcome> {
  const { rt, row } = run;
  const f = sendFailureOf(error);
  const outcome = classifySendFailure(f);
  const status = f.kind === "status" ? f.status : null;
  const debugId = error instanceof HttpStatusError ? (error.debugId ?? null) : null;
  run.ctx.log.warn(
    { actionId: row.id, failure: f.kind, status, debugId, error: String(error) },
    `${label} send failed`,
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
