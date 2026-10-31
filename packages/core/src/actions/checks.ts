// The execution checks of `action.execute` (ADR 0010), each pure and run in this order by the worker,
// which does the I/O between them. The first failure ends the run: the action goes `failed` with the
// seller-facing code, an audit row records it, and nothing is sent to PayPal.
//   1 kill_switch   AGENT_KILL_SWITCH env or the platform_flags row         → KILL_SWITCH
//   2 payload_hash  canonicalHash(payload) = approval hash = stored hash    → PAYLOAD_CHANGED
//   3 blob_hash     sha256 of the compiled blob bytes = the payload's       → BLOB_CHANGED
//   4 ownership     paypal_resource_owner(dispute) = the action's workspace  → NOT_OWNED
//   5 action_link   the re-fetched dispute's links carry the kind's rel     → ACTION_LINK_MISSING
//   6 deadline      now < seller_response_due_date − 1 h (cutoff refuses)   → DEADLINE_PASSED
// Then the outcome codes of the send itself and of reconcile.
import type { Sha256 } from "../ids.ts";
import { addMinutes, compareInstants, type Instant } from "../time.ts";
import { DEADLINE_MARGIN_MINUTES } from "./policy.ts";

export const EXECUTION_CHECKS = [
  "kill_switch",
  "payload_hash",
  "blob_hash",
  "ownership",
  "action_link",
  "deadline",
] as const;
export type ExecutionCheck = (typeof EXECUTION_CHECKS)[number];

export const EXECUTION_REFUSAL_CODES = [
  "KILL_SWITCH",
  "PAYLOAD_CHANGED",
  "BLOB_CHANGED",
  "NOT_OWNED",
  "ACTION_LINK_MISSING",
  "DEADLINE_PASSED",
] as const;
export type ExecutionRefusalCode = (typeof EXECUTION_REFUSAL_CODES)[number];

/** Every code a `failed` action can carry (`proposed_actions.refusal_code`). */
export const ACTION_FAILURE_CODES = [
  ...EXECUTION_REFUSAL_CODES,
  /** stored payload no longer parses for its kind, or the kind is not executable */
  "INVALID_PAYLOAD",
  /** PayPal's published file/notes limits, checked before sending */
  "EVIDENCE_REJECTED",
  /** PayPal answered 4xx: a business refusal, nothing applied, never retried */
  "PAYPAL_REJECTED",
  /** nothing was sent: the re-fetch failed or the breaker was open */
  "PAYPAL_UNAVAILABLE",
  /** an `unknown` send whose effect never showed up after the last reconcile try */
  "RECONCILE_NOT_APPLIED",
] as const;
export type ActionFailureCode = (typeof ACTION_FAILURE_CODES)[number];

export type CheckResult =
  | { readonly check: ExecutionCheck; readonly ok: true }
  | { readonly check: ExecutionCheck; readonly ok: false; readonly code: ExecutionRefusalCode };

function result(check: ExecutionCheck, pass: boolean, code: ExecutionRefusalCode): CheckResult {
  return pass ? { check, ok: true } : { check, ok: false, code };
}

export function checkKillSwitch(on: boolean): CheckResult {
  return result("kill_switch", !on, "KILL_SWITCH");
}

/** The payload about to be sent hashes to what the seller approved, and to the stored hash. */
export function checkPayloadHash(h: {
  readonly recomputed: Sha256;
  readonly approved: string;
  readonly stored: string;
}): CheckResult {
  return result("payload_hash", h.recomputed === h.approved && h.recomputed === h.stored, "PAYLOAD_CHANGED");
}

/** `expected` null = the payload carries no blob (passes). `actual` null = the blob is gone. */
export function checkBlobHash(h: {
  readonly expected: string | null;
  readonly actual: Sha256 | null;
}): CheckResult {
  return result("blob_hash", h.expected === null || h.expected === h.actual, "BLOB_CHANGED");
}

export function checkOwnership(o: {
  readonly actionWorkspaceId: string;
  readonly ownerWorkspaceId: string | null;
}): CheckResult {
  return result(
    "ownership",
    o.ownerWorkspaceId !== null && o.ownerWorkspaceId === o.actionWorkspaceId,
    "NOT_OWNED",
  );
}

/** The action kind's rel (e.g. `provide_evidence`) must be among the re-fetched dispute's link rels. */
export function checkActionLink(l: {
  readonly kind: string;
  readonly allowedActions: readonly string[];
}): CheckResult {
  return result("action_link", l.allowedActions.includes(l.kind), "ACTION_LINK_MISSING");
}

/** Refuses at or after `due − 60 min` (ADR 0010; the same cutoff as `canExecute`). No due date passes. */
export function checkDeadline(d: { readonly now: Instant; readonly dueDate: Instant | null }): CheckResult {
  if (d.dueDate === null) return { check: "deadline", ok: true };
  const cutoff = addMinutes(d.dueDate, -DEADLINE_MARGIN_MINUTES);
  return result("deadline", compareInstants(d.now, cutoff) < 0, "DEADLINE_PASSED");
}

// ---- send outcome --------------------------------------------------------------------------------

/** How a send ended, from what the HTTP layer saw. */
export type SendFailure =
  /** no write left the process: the pre-send GET failed, the breaker was open */
  | { readonly kind: "not_sent" }
  /** the dispute's link was gone at the client's own re-check (before the write) */
  | { readonly kind: "link_missing" }
  /** PayPal answered with this status */
  | { readonly kind: "status"; readonly status: number }
  /** the write was sent and no answer came (timeout, reset) */
  | { readonly kind: "no_answer" };

export type SendOutcome =
  { readonly next: "failed"; readonly code: ActionFailureCode } | { readonly next: "unknown" };

/** 4xx → failed (no retry); 5xx, timeout or reset after the send → unknown (reconcile, never resend). */
export function classifySendFailure(f: SendFailure): SendOutcome {
  if (f.kind === "not_sent") return { next: "failed", code: "PAYPAL_UNAVAILABLE" };
  if (f.kind === "link_missing") return { next: "failed", code: "ACTION_LINK_MISSING" };
  if (f.kind === "status" && f.status < 500) return { next: "failed", code: "PAYPAL_REJECTED" };
  return { next: "unknown" };
}

// ---- reconcile -----------------------------------------------------------------------------------

export const RECONCILE_MAX_TRIES = 5;
/** The first reconcile runs 2 min after the `unknown`; then 4, 8, 16, 32 min apart. */
export const RECONCILE_FIRST_DELAY_SECONDS = 120;

export function reconcileDelaySeconds(attempt: number): number {
  return RECONCILE_FIRST_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1);
}

/** What reconcile compares: the dispute before the send and the fresh re-read. */
export interface DisputeSnapshot {
  readonly status: string;
  readonly allowedActions: readonly string[];
  /** seller evidence + supporting-info entries; null when unknown (e.g. recovered from a crash) */
  readonly sellerSubmissions: number | null;
}

export type ReconcileVerdict = "landed" | "not_landed";

/**
 * Landed when the action's link is gone **and** the status moved (e.g. → UNDER_REVIEW), or when our
 * submission is listed (more seller submissions than before the send). `update_time` alone proves
 * nothing: PayPal moves it for its own reasons.
 */
export function reconcileVerdict(
  kind: string,
  before: DisputeSnapshot,
  after: DisputeSnapshot,
): ReconcileVerdict {
  const linkGone = !after.allowedActions.includes(kind);
  const statusMoved = after.status !== before.status;
  const listed =
    before.sellerSubmissions !== null &&
    after.sellerSubmissions !== null &&
    after.sellerSubmissions > before.sellerSubmissions;
  return (linkGone && statusMoved) || listed ? "landed" : "not_landed";
}
