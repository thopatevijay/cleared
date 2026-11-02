// deriveHold (M3-01, B6 #4): a hold is a mirrored capture with `status == PENDING` and a
// `status_details.reason`. Nothing else makes one: a dispute only links to the hold (its id and reply
// deadline); the money is held only while PayPal says the capture is PENDING. Pure, no I/O.
import type { Instant } from "../time.ts";
import { ruleForReason, type HoldEstimate, type HoldType } from "./rules.ts";

/** The capture as Cleared mirrors it (PayPal's raw strings). */
export interface CaptureFacts {
  readonly status: string;
  readonly reason: string | null;
  /** PayPal's `update_time` of the mirrored capture (when it was seen PENDING) */
  readonly updateTime: Instant;
}

/** The dispute on the same capture, when one is mirrored. */
export interface LinkedDispute {
  readonly disputeId: string;
  readonly status: string;
  readonly sellerResponseDueDate: Instant | null;
}

export interface DerivedHold {
  readonly type: HoldType;
  /** `status_details.reason`, verbatim */
  readonly reason: string;
  readonly openedAt: Instant;
  readonly estimatedReleaseAt: Instant | null;
  readonly estimate: HoldEstimate | null;
  /** the rule row (rules.ts) the estimate and its source come from */
  readonly estimateRuleId: string;
  /** dispute-linked holds: PayPal's dispute id, and its reply deadline (shown instead of a date) */
  readonly disputeId: string | null;
  readonly disputeDueAt: Instant | null;
}

export function deriveHold(capture: CaptureFacts, dispute: LinkedDispute | null = null): DerivedHold | null {
  if (capture.status !== "PENDING" || capture.reason === null || capture.reason === "") return null;
  const rule = ruleForReason(capture.reason);
  const estimate = rule.estimate(capture.updateTime);
  const linked = rule.type === "dispute" ? dispute : null;
  return {
    type: rule.type,
    reason: capture.reason,
    openedAt: capture.updateTime,
    estimatedReleaseAt: estimate?.at ?? null,
    estimate,
    estimateRuleId: rule.id,
    disputeId: linked?.disputeId ?? null,
    disputeDueAt: linked?.sellerResponseDueDate ?? null,
  };
}
