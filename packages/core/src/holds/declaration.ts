// The seller's declaration (BL-01 6570499264, owner decision 2026-11-03 "option A", ADR 0017 addendum 3).
// PayPal never says whether a held payment was goods or a service, and the sandbox can't produce the
// new-seller goods/service holds that PayPal's release rules describe. So the seller says it: "goods" or
// "service". The declaration is Cleared's own field, never a PayPal state, and it only selects the guided
// action (goods → route advice + File tracking, service → the guided Completed step).
//
// The hard rule (research note on #35, n = 2: a PENDING_REVIEW hold released at 24 h with or without
// tracking): a hold's release rule follows PayPal's own hold type, never the declaration. The
// "about 24 h after delivery" (goods_delivered) and "7 days after Completed" (service_completed) rules apply
// only to a hold PayPal itself typed goods / service. Pure: no I/O.
import { z } from "zod";
import type { ActionState } from "../actions/state.ts";
import { err, ok, type Result } from "../result.ts";
import { DECLARED_KINDS, type DeclaredKind, type GuidedAction } from "./kinds.ts";
import { GOODS_DELIVERED_RULE, SERVICE_COMPLETED_RULE, type HoldRule, type HoldType } from "./rules.ts";
import type { HoldState } from "./state.ts";

// The kinds and guidedAction live in kinds.ts (no zod) for the browser (M4-08).
export {
  DECLARED_KINDS,
  declaredKindOf,
  GUIDED_ACTIONS,
  guidedAction,
  holdTypeOf,
  type DeclaredKind,
  type GuidedAction,
} from "./kinds.ts";

/**
 * The rule a filed guided action may switch the hold's estimate to: goods_delivered after tracking on a
 * hold PayPal typed goods, service_completed after Completed on a hold PayPal typed service. Anything else
 * (a payment review, a dispute, any other PayPal reason, whatever the seller declared) → null: the hold
 * keeps PayPal's rule for its reason.
 */
export function releaseRuleAfterAction(type: HoldType, action: GuidedAction): HoldRule | null {
  if (action === "tracking" && type === "goods") return GOODS_DELIVERED_RULE;
  if (action === "completed" && type === "service") return SERVICE_COMPLETED_RULE;
  return null;
}

/** A declaration only matters where PayPal's type doesn't already pick the action, on an unreleased hold. */
export function canDeclare(type: HoldType, state: HoldState): boolean {
  return state !== "released" && type !== "goods" && type !== "service" && type !== "sample";
}

/** Hold states past an approval: the declaration is locked there. */
const LOCKED_HOLD_STATES: readonly HoldState[] = ["approved", "filed", "still_held", "released"];
/** Action states reached only after the seller approved it. */
const APPROVED_ACTION_STATES: readonly ActionState[] = [
  "approved",
  "executing",
  "succeeded",
  "failed",
  "unknown",
];

export interface LockFacts {
  readonly state: HoldState;
  /** the seller confirmed the guided Completed step */
  readonly completedConfirmed: boolean;
  /** the newest add_tracking / record_service_completed action states on the hold's capture */
  readonly actionStates: readonly ActionState[];
}

/** Changeable until an action is approved (or Completed is confirmed); locked after. */
export function declarationLocked(f: LockFacts): boolean {
  return (
    LOCKED_HOLD_STATES.includes(f.state) ||
    f.completedConfirmed ||
    f.actionStates.some((s) => APPROVED_ACTION_STATES.includes(s))
  );
}

export const DECLARATION_REFUSALS = ["NOT_DECLARABLE", "DECLARATION_LOCKED"] as const;
export type DeclarationRefusal = (typeof DECLARATION_REFUSALS)[number];

export interface DeclareInput {
  readonly type: HoldType;
  readonly lock: LockFacts;
  readonly current: DeclaredKind | null;
  readonly next: DeclaredKind;
}

/** Whether the seller may set `next`; `changed: false` when it is already the declaration (idempotent). */
export function decideDeclaration(
  i: DeclareInput,
): Result<{ readonly changed: boolean }, DeclarationRefusal> {
  if (!canDeclare(i.type, i.lock.state)) return err("NOT_DECLARABLE");
  if (i.current === i.next) return ok({ changed: false });
  if (declarationLocked(i.lock)) return err("DECLARATION_LOCKED");
  return ok({ changed: true });
}

/** On `HoldItem` / `PaymentHold`: the seller's declaration, labelled as theirs wherever it shows. */
export const DeclarationSchema = z.object({
  /** null: not declared yet */
  kind: z.enum(DECLARED_KINDS).nullable(),
  declaredAt: z.iso.datetime({ offset: true }).nullable(),
  /** false on a hold PayPal already typed, a released hold or a sample */
  declarable: z.boolean(),
  /** true once an action was approved (or Completed confirmed) */
  locked: z.boolean(),
});
export type Declaration = z.infer<typeof DeclarationSchema>;

/** POST /api/holds/:id/declaration body. */
export const DeclareBodySchema = z.strictObject({ kind: z.enum(DECLARED_KINDS) });
