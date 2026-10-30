// canExecute: the last gate before a PayPal write (ADR 0010). Pure; the caller supplies a fresh
// re-fetch (hasActionLink, dueDate), the hash of the payload about to be sent, and the kill switch.
import type { Sha256 } from "../ids.ts";
import { addMinutes, compareInstants, type Instant } from "../time.ts";
import type { Approval, ProposedAction } from "./action.ts";

/** No action runs at or after `seller_response_due_date − 1 h`. */
export const DEADLINE_MARGIN_MINUTES = 60;

export const REFUSAL_REASONS = [
  "kill_switch_on",
  "not_approved",
  "no_approval",
  "hash_mismatch",
  "past_deadline",
  "no_action_link",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface ExecutionContext {
  readonly now: Instant;
  /** the dispute's seller_response_due_date from the fresh re-fetch; null when the action has no deadline */
  readonly dueDate: Instant | null;
  /** the matching HATEOAS link is in the freshly fetched resource */
  readonly hasActionLink: boolean;
  readonly approval: Approval | null;
  /** sha256 of canonicalJson(payload) computed now, from the exact payload about to be sent */
  readonly payloadSha256: Sha256;
  readonly killSwitch: boolean;
}

export type ExecutionDecision =
  { readonly kind: "allow" } | { readonly kind: "refuse"; readonly reason: RefusalReason };

function refuse(reason: RefusalReason): ExecutionDecision {
  return { kind: "refuse", reason };
}

export function canExecute(action: ProposedAction, ctx: ExecutionContext): ExecutionDecision {
  if (ctx.killSwitch) return refuse("kill_switch_on");
  if (action.state !== "approved") return refuse("not_approved");
  if (ctx.approval?.actionId !== action.id) return refuse("no_approval");
  if (ctx.approval.payloadSha256 !== action.payloadSha256 || ctx.payloadSha256 !== action.payloadSha256) {
    return refuse("hash_mismatch");
  }
  if (ctx.dueDate !== null) {
    const cutoff = addMinutes(ctx.dueDate, -DEADLINE_MARGIN_MINUTES);
    if (compareInstants(ctx.now, cutoff) >= 0) return refuse("past_deadline");
  }
  if (!ctx.hasActionLink) return refuse("no_action_link");
  return { kind: "allow" };
}
