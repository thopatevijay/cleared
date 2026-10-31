// `action.execute` (M2-08, ADR 0010): the one governed path for a PayPal write.
// 1. Claim (own committed tx, row lock): `approved` → `executing` and the action's single `executions`
//    row (idempotency_key = action id = PayPal-Request-Id). Committed BEFORE any PayPal call, so a
//    redelivered job never sends twice: one that finds `executing` cannot know whether the send left, so
//    it goes `unknown` and reconciles (dispute writes are not idempotent at PayPal: M0-05).
// 2. Checks in order (core checks.ts), each with an audit row: kill switch, payload hash, blob hash,
//    ownership, the re-fetched dispute's HATEOAS link, deadline. A refusal → `failed` + code, no write.
// 3. Send. 2xx → `succeeded` + a dispute re-sync; 4xx → `failed` (no retry; the breaker ignores 4xx);
//    timeout / reset / 5xx after the send → `unknown` + `action.reconcile` in 2 minutes.
// Every transition commits with its audit row and outbox event in one transaction.
import {
  canonicalHash,
  checkActionLink,
  checkBlobHash,
  checkDeadline,
  checkKillSwitch,
  checkOwnership,
  checkPayloadHash,
  classifySendFailure,
  fromEpochMs,
  mapDispute,
  parseExecutablePayload,
  RECONCILE_FIRST_DELAY_SECONDS,
  type CheckResult,
  type DisputeSnapshot,
  type ExecutablePayload,
  type JsonValue,
  type SendFailure,
  type Sha256,
  WorkspaceIdSchema,
} from "@cleared/core";
import {
  CircuitOpenError,
  DisputeActionNotAllowedError,
  EvidenceRejectedError,
  HttpError,
  HttpStatusError,
  type Dispute,
  type DisputeWriteResponse,
  type PayPalDisputesClient,
  type WriteResponseMeta,
} from "@cleared/adapters";
import {
  appendActionAudit,
  approvalForAction,
  claimExecution,
  forWorkspace,
  getProposedAction,
  PAYPAL_DISPUTE_SYNC_QUEUE,
  platform,
  recordExecutionOutcome,
  setProposedActionState,
  withTransaction,
  type ProposedActionRow,
  type Tx,
} from "@cleared/db";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConsumeContext, Handler } from "../consume.ts";
import {
  endAction,
  enqueueReconcile,
  mirrorFetched,
  snapshotOf,
  type ActionRuntime,
  type Ending,
} from "./action-runtime.ts";

export const ExecuteActionInputSchema = z.object({ actionId: z.uuid(), workspaceId: z.uuid() });
export type ExecuteActionInput = z.infer<typeof ExecuteActionInputSchema>;

export type ActionWrites = Pick<
  PayPalDisputesClient,
  "getDispute" | "provideEvidence" | "provideSupportingInfo" | "acceptClaim"
>;

export interface ExecuteActionDeps extends ActionRuntime {
  readonly disputes: ActionWrites;
  /** `AGENT_KILL_SWITCH` (env); the DB flag is read on every run */
  readonly killSwitchEnv: () => boolean;
  /** per-call timeout of the write itself (the client default otherwise) */
  readonly writeTimeoutMs?: number;
}

export type ExecuteOutcome = "skipped" | "succeeded" | "failed" | "unknown";

export function executeActionHandler(deps: ExecuteActionDeps): Handler {
  return async (data, ctx) => {
    await executeAction(deps, ExecuteActionInputSchema.parse(data), ctx);
  };
}

export async function executeAction(
  deps: ExecuteActionDeps,
  input: ExecuteActionInput,
  ctx: ConsumeContext,
): Promise<ExecuteOutcome> {
  const claim = await claimAction(deps, input);
  ctx.log.info({ actionId: input.actionId, claim: claim.mode }, "action execute");
  if (claim.mode === "skip") return "skipped";
  if (claim.mode === "recover") return recoverUnknown(deps, claim.row);
  const run: Run = { deps, row: claim.row, ctx };
  const prepared = await runChecks(run);
  if (prepared.kind === "refused") return "failed";
  return send(run, prepared);
}

interface Run {
  readonly deps: ExecuteActionDeps;
  readonly row: ProposedActionRow;
  readonly ctx: ConsumeContext;
}

type Claim =
  { readonly mode: "skip" } | { readonly mode: "run" | "recover"; readonly row: ProposedActionRow };

/** Own transaction, committed before anything is sent. */
async function claimAction(deps: ExecuteActionDeps, input: ExecuteActionInput): Promise<Claim> {
  return withTransaction(deps.db, async (tx): Promise<Claim> => {
    const row = await getProposedAction(deps.db, input.workspaceId, input.actionId, { tx, lock: true });
    if (row?.state === "executing") return { mode: "recover", row };
    if (row?.state !== "approved") return { mode: "skip" };
    const claimed = await claimExecution(deps.db, { workspaceId: row.workspaceId, actionId: row.id }, tx);
    await setProposedActionState(deps.db, row.workspaceId, row.id, { from: "approved", to: "executing" }, tx);
    if (claimed === null) return { mode: "recover", row: { ...row, state: "executing" } };
    return { mode: "run", row: { ...row, state: "executing" } };
  });
}

/** A redelivery found the action `executing`: the send may have left. Never resend; reconcile. */
async function recoverUnknown(deps: ExecuteActionDeps, row: ProposedActionRow): Promise<ExecuteOutcome> {
  await withTransaction(deps.db, async (tx) => {
    const mirror = await mirrorOf(deps, row, tx);
    await endAction(deps, tx, row, "executing", { to: "unknown" }, { reason: "redelivered_while_executing" });
    await enqueueReconcile(
      deps,
      tx,
      { actionId: row.id, workspaceId: row.workspaceId, attempt: 1, before: mirror },
      RECONCILE_FIRST_DELAY_SECONDS,
    );
  });
  return "unknown";
}

async function mirrorOf(deps: ExecuteActionDeps, row: ProposedActionRow, tx: Tx): Promise<DisputeSnapshot> {
  const disputeId = z.object({ dispute_id: z.string() }).safeParse(row.payload).data?.dispute_id ?? "";
  const m = await forWorkspace(deps.db, WorkspaceIdSchema.parse(row.workspaceId)).disputes.getByDisputeId(
    disputeId,
    tx,
  );
  return {
    status: m?.status ?? "",
    allowedActions: z.array(z.string()).catch([]).parse(m?.allowedActions),
    sellerSubmissions: null,
  };
}

// ---- checks ----------------------------------------------------------------------------------------

interface Prepared {
  readonly kind: "ready";
  readonly executable: ExecutablePayload;
  readonly pdf: Uint8Array | null;
  readonly before: Dispute;
}

async function audit(run: Run, action: string, detail: Record<string, JsonValue>): Promise<void> {
  await appendActionAudit(run.deps.db, {
    workspaceId: run.row.workspaceId,
    actionId: run.row.id,
    actor: "system",
    action,
    detail,
  });
}

/** Records the check; on a failure ends the action `failed` with its code. Returns whether it passed. */
async function record(run: Run, r: CheckResult, extra: Record<string, JsonValue> = {}): Promise<boolean> {
  await audit(run, "action.check", { check: r.check, ok: r.ok, ...(r.ok ? {} : { code: r.code }), ...extra });
  if (!r.ok) await finish(run, { to: "failed", code: r.code, debugId: null });
  return r.ok;
}

async function finish(run: Run, end: Ending, detail: Record<string, JsonValue> = {}): Promise<void> {
  await withTransaction(run.deps.db, (tx) => endAction(run.deps, tx, run.row, "executing", end, detail));
}

async function runChecks(run: Run): Promise<Prepared | { readonly kind: "refused" }> {
  const refused = { kind: "refused" } as const;
  const { deps, row } = run;
  const killSwitch = deps.killSwitchEnv() || (await platform(deps.db).flags.agentKillSwitch());
  if (!(await record(run, checkKillSwitch(killSwitch)))) return refused;
  const approval = await approvalForAction(deps.db, row.workspaceId, row.id);
  const recomputed = canonicalHash(row.payload as JsonValue);
  const hash = checkPayloadHash({
    recomputed,
    approved: approval?.payloadSha256 ?? "",
    stored: row.payloadSha256,
  });
  if (!(await record(run, hash, { recomputed }))) return refused;
  const executable = parseExecutablePayload(row.kind, row.payload);
  if (executable === null) {
    await finish(run, { to: "failed", code: "INVALID_PAYLOAD", debugId: null });
    return refused;
  }
  const blob = await loadBlob(run, executable);
  if (!(await record(run, checkBlobHash({ expected: blob.expected, actual: blob.actual })))) return refused;
  return checkDispute(run, executable, blob.bytes);
}

/** Checks 4–6: ownership, then the re-fetched dispute's link, then the deadline. */
async function checkDispute(run: Run, executable: ExecutablePayload, pdf: Uint8Array | null) {
  const refused = { kind: "refused" } as const;
  const { deps, row } = run;
  const disputeId = executable.payload.dispute_id;
  const owner = await platform(deps.db).resourceOwners.get("dispute", disputeId);
  const owned = checkOwnership({
    actionWorkspaceId: row.workspaceId,
    ownerWorkspaceId: owner?.workspaceId ?? null,
  });
  if (!(await record(run, owned))) return refused;
  let fetched: Dispute;
  try {
    fetched = await deps.disputes.getDispute(disputeId);
  } catch (error) {
    await finish(run, { to: "failed", code: "PAYPAL_UNAVAILABLE", debugId: null }, { error: String(error) });
    return refused;
  }
  await withTransaction(deps.db, (tx) => mirrorFetched(deps, tx, fetched, run.ctx));
  const mapped = mapDispute(fetched);
  const allowed = mapped.ok ? mapped.value.allowedActions : [];
  if (
    !(await record(run, checkActionLink({ kind: row.kind, allowedActions: allowed }), {
      links: [...allowed],
    }))
  )
    return refused;
  const dueDate = mapped.ok ? mapped.value.sellerResponseDueDate : null;
  const now = fromEpochMs(deps.now().getTime());
  if (!(await record(run, checkDeadline({ now, dueDate }), { now, dueDate }))) return refused;
  return { kind: "ready", executable, pdf, before: fetched } as const;
}

interface BlobCheck {
  readonly expected: string | null;
  readonly actual: Sha256 | null;
  readonly bytes: Uint8Array | null;
}

/** The compiled PDF the payload names (draft → compiled blob), hashed from its bytes now. */
async function loadBlob(run: Run, e: ExecutablePayload): Promise<BlobCheck> {
  if (
    e.kind === "accept_claim" ||
    e.payload.compiled_blob_sha256 === undefined ||
    e.payload.draft_id === undefined
  ) {
    return { expected: null, actual: null, bytes: null };
  }
  const ws = forWorkspace(run.deps.db, WorkspaceIdSchema.parse(run.row.workspaceId));
  const draft = await ws.disputeDrafts.get(e.payload.draft_id);
  const blob = draft?.compiledBlobId == null ? null : await ws.blobs.get(draft.compiledBlobId);
  const bytes = blob === null ? null : new Uint8Array(blob.bytes);
  const actual = bytes === null ? null : (createHash("sha256").update(bytes).digest("hex") as Sha256);
  return { expected: e.payload.compiled_blob_sha256, actual, bytes };
}

// ---- send ------------------------------------------------------------------------------------------

function write(
  run: Run,
  p: Prepared,
  onResponse: (m: WriteResponseMeta) => void,
): Promise<DisputeWriteResponse> {
  const { deps, row } = run;
  const o = {
    requestId: row.id,
    onResponse,
    ...(deps.writeTimeoutMs === undefined ? {} : { timeoutMs: deps.writeTimeoutMs }),
  };
  const e = p.executable;
  const files = p.pdf === null ? [] : [{ name: `evidence-${e.payload.dispute_id}.pdf`, bytes: p.pdf }];
  if (e.kind === "provide_evidence") {
    const input = { evidenceType: e.payload.evidence_type, notes: e.payload.notes, files };
    return deps.disputes.provideEvidence(e.payload.dispute_id, input, o);
  }
  if (e.kind === "provide_supporting_info") {
    return deps.disputes.provideSupportingInfo(e.payload.dispute_id, { notes: e.payload.notes, files }, o);
  }
  const accept = { note: e.payload.note, acceptClaimType: e.payload.accept_claim_type };
  return deps.disputes.acceptClaim(e.payload.dispute_id, accept, o);
}

async function send(run: Run, p: Prepared): Promise<ExecuteOutcome> {
  let meta: WriteResponseMeta | null = null;
  try {
    const response = await write(run, p, (m) => (meta = m));
    const m = meta as WriteResponseMeta | null;
    return await succeeded(run, p, { status: m?.status ?? 200, debugId: m?.debugId ?? null, response });
  } catch (error) {
    return failedSend(run, p, error);
  }
}

async function succeeded(
  run: Run,
  p: Prepared,
  r: { readonly status: number; readonly debugId: string | null; readonly response: unknown },
): Promise<ExecuteOutcome> {
  const { deps, row } = run;
  await withTransaction(deps.db, async (tx) => {
    await recordExecutionOutcome(
      deps.db,
      row.workspaceId,
      row.id,
      {
        paypalStatus: String(r.status),
        paypalDebugId: r.debugId,
        response: r.response,
      },
      tx,
    );
    await appendActionAudit(deps.db, sent(row, { status: r.status, debugId: r.debugId }), tx);
    await endAction(
      deps,
      tx,
      row,
      "executing",
      { to: "succeeded", debugId: r.debugId },
      { debugId: r.debugId },
    );
    await deps.publisher.enqueue(
      tx,
      PAYPAL_DISPUTE_SYNC_QUEUE,
      { disputeId: p.executable.payload.dispute_id, source: "poll" },
      { workspaceId: row.workspaceId },
    );
  });
  return "succeeded";
}

function sent(
  row: ProposedActionRow,
  detail: { status: number | null; debugId: string | null; outcome?: string },
) {
  return {
    workspaceId: row.workspaceId,
    actionId: row.id,
    actor: "system" as const,
    action: "action.sent",
    detail: { requestId: row.id, ...detail },
  };
}

/** What the HTTP layer saw: was a write sent, and did PayPal answer? */
export function sendFailureOf(error: unknown): SendFailure {
  if (error instanceof DisputeActionNotAllowedError) return { kind: "link_missing" };
  if (error instanceof CircuitOpenError) return { kind: "not_sent" };
  if (error instanceof HttpError && error.method === "GET") return { kind: "not_sent" };
  if (error instanceof HttpStatusError) return { kind: "status", status: error.status };
  // a timeout or reset on the write, or anything unexpected after it may have left: unknown
  return { kind: "no_answer" };
}

async function failedSend(run: Run, p: Prepared, error: unknown): Promise<ExecuteOutcome> {
  const { deps, row } = run;
  if (error instanceof EvidenceRejectedError) {
    await finish(run, { to: "failed", code: "EVIDENCE_REJECTED", debugId: null }, { error: error.code });
    return "failed";
  }
  const f = sendFailureOf(error);
  const outcome = classifySendFailure(f);
  const status = f.kind === "status" ? f.status : null;
  const debugId = error instanceof HttpStatusError ? (error.debugId ?? null) : null;
  run.ctx.log.warn(
    { actionId: row.id, failure: f.kind, status, debugId, error: String(error) },
    "action send failed",
  );
  await withTransaction(deps.db, async (tx) => {
    const body = error instanceof HttpStatusError ? error.bodyText.slice(0, 4000) : null;
    if (f.kind === "status" || f.kind === "no_answer") {
      await recordExecutionOutcome(
        deps.db,
        row.workspaceId,
        row.id,
        {
          paypalStatus: status === null ? null : String(status),
          paypalDebugId: debugId,
          response: body === null ? null : { body },
        },
        tx,
      );
      await appendActionAudit(deps.db, sent(row, { status, debugId, outcome: f.kind }), tx);
    }
    if (outcome.next === "failed") {
      await endAction(
        deps,
        tx,
        row,
        "executing",
        { to: "failed", code: outcome.code, debugId },
        { failure: f.kind },
      );
      return;
    }
    await endAction(deps, tx, row, "executing", { to: "unknown" }, { failure: f.kind });
    const before = snapshotOf(p.before);
    await enqueueReconcile(
      deps,
      tx,
      { actionId: row.id, workspaceId: row.workspaceId, attempt: 1, before },
      RECONCILE_FIRST_DELAY_SECONDS,
    );
  });
  return outcome.next;
}
