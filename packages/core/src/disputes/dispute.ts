// Dispute: PayPal's states are mirror-only (applyMirror); our own states cover the response draft.
import { domainError, type DomainError } from "../errors.ts";
import type { CaptureId, DisputeId, EvidenceItemId, Sha256, WorkspaceId } from "../ids.ts";
import { transition, type Machine } from "../machine.ts";
import { mirrorEnum, type Mirrored } from "../mirror.ts";
import { err, ok, type Result } from "../result.ts";
import type { Instant } from "../time.ts";

/** PayPal Disputes v1 `status`. */
export const DISPUTE_STATUSES = [
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** PayPal Disputes v1 `dispute_life_cycle_stage`. */
export const DISPUTE_STAGES = ["INQUIRY", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

/**
 * PayPal Disputes v1 `dispute_outcome.outcome_code`. In the sandbox a represented chargeback ends
 * `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`: say "seller keeps the money (PayPal covered the case)".
 */
export const DISPUTE_OUTCOME_CODES = [
  "RESOLVED_BUYER_FAVOUR",
  "RESOLVED_SELLER_FAVOUR",
  "RESOLVED_WITH_PAYOUT",
  "CANCELED_BY_BUYER",
  "ACCEPTED",
  "DENIED",
  "NONE",
] as const;
export type DisputeOutcomeCode = (typeof DISPUTE_OUTCOME_CODES)[number];

export interface DisputeMirrorState {
  readonly status: Mirrored<DisputeStatus>;
  readonly stage: Mirrored<DisputeStage> | null;
  readonly outcome: Mirrored<DisputeOutcomeCode> | null;
}

export function mapDisputeState(raw: {
  readonly status: string;
  readonly stage: string | null;
  readonly outcomeCode: string | null;
}): DisputeMirrorState {
  return {
    status: mirrorEnum(DISPUTE_STATUSES, raw.status),
    stage: raw.stage === null ? null : mirrorEnum(DISPUTE_STAGES, raw.stage),
    outcome: raw.outcomeCode === null ? null : mirrorEnum(DISPUTE_OUTCOME_CODES, raw.outcomeCode),
  };
}

export interface Dispute {
  readonly workspaceId: WorkspaceId;
  readonly disputeId: DisputeId;
  readonly captureId: CaptureId | null;
  readonly reason: string;
  readonly state: DisputeMirrorState;
  readonly sellerResponseDueDate: Instant | null;
  /** HATEOAS `rel`s in the dispute's current links: the only actions Cleared may offer */
  readonly allowedActions: readonly string[];
  readonly updateTime: Instant;
}

// --- Our states: the response draft ---------------------------------------------------------------

export const DRAFT_STATES = ["draft_ready", "approved", "filed"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export const DRAFT_EVENTS = ["draft_approved", "draft_filed"] as const;
export type DraftEvent = (typeof DRAFT_EVENTS)[number];

export const disputeDraftMachine: Machine<DraftState, DraftEvent> = {
  name: "DisputeDraft",
  initial: "draft_ready",
  states: DRAFT_STATES,
  events: DRAFT_EVENTS,
  table: {
    draft_ready: { draft_approved: "approved" },
    approved: { draft_filed: "filed" },
    filed: {},
  },
};

export function transitionDraft(state: DraftState, event: DraftEvent): Result<DraftState, DomainError> {
  return transition(disputeDraftMachine, state, event);
}

/** PayPal evidence limits: notes ≤ 2000 chars; files jpg/gif/png/pdf, < 10 MB each, ≤ 50 MB per call. */
export const DISPUTE_NOTES_MAX_CHARS = 2000;
export const EVIDENCE_FILE_MIMES = ["image/jpeg", "image/gif", "image/png", "application/pdf"] as const;
/** Decimal megabytes: the stricter reading of PayPal's "10 MB" / "50 MB". */
export const EVIDENCE_FILE_MAX_BYTES = 10_000_000;
export const EVIDENCE_CALL_MAX_BYTES = 50_000_000;

export interface DisputeDraft {
  readonly workspaceId: WorkspaceId;
  readonly disputeId: DisputeId;
  readonly notes: string;
  readonly evidenceItemIds: readonly EvidenceItemId[];
  /** sha256 of the compiled draft: what an approval binds to */
  readonly sha256: Sha256;
  readonly state: DraftState;
}

export interface EvidenceFile {
  readonly mime: string;
  readonly sizeBytes: number;
}

function violation(message: string, details: Record<string, unknown>): Result<never, DomainError> {
  return err(domainError("invariant_violated", message, details));
}

/** Checks a draft's notes and files against PayPal's limits before anything is compiled or sent. */
export function checkDraftLimits(notes: string, files: readonly EvidenceFile[]): Result<true, DomainError> {
  if (notes.length > DISPUTE_NOTES_MAX_CHARS) {
    return violation("notes exceed 2000 characters", { length: notes.length });
  }
  let total = 0;
  for (const [index, file] of files.entries()) {
    if (!EVIDENCE_FILE_MIMES.some((m) => m === file.mime)) {
      return violation("evidence file type not accepted by PayPal", { index, mime: file.mime });
    }
    if (file.sizeBytes >= EVIDENCE_FILE_MAX_BYTES) {
      return violation("evidence file must be under 10 MB", { index, sizeBytes: file.sizeBytes });
    }
    total += file.sizeBytes;
  }
  if (total > EVIDENCE_CALL_MAX_BYTES) return violation("evidence files exceed 50 MB per call", { total });
  return ok(true);
}
