// The declaration's kinds and the guided action they select, without zod (M4-08): the dashboard and the
// hold detail render these in the browser, and declaration.ts (which holds the zod schemas) re-exports them.
import { HOLD_TYPES, type HoldType } from "./rules.ts";

export const DECLARED_KINDS = ["goods", "service"] as const;
export type DeclaredKind = (typeof DECLARED_KINDS)[number];

/** The action slot's guided action: M3-03 tracking, or M3-04's guided Completed step. */
export const GUIDED_ACTIONS = ["tracking", "completed"] as const;
export type GuidedAction = (typeof GUIDED_ACTIONS)[number];

/** A stored `holds.type` as a `HoldType` (an unknown value reads as "other"). */
export function holdTypeOf(raw: string): HoldType {
  return (HOLD_TYPES as readonly string[]).includes(raw) ? (raw as HoldType) : "other";
}

/** A stored `holds.seller_declared_kind` as a `DeclaredKind`, or null. */
export function declaredKindOf(raw: string | null): DeclaredKind | null {
  return raw === "goods" || raw === "service" ? raw : null;
}

/** PayPal's own type picks the action; otherwise the seller's declaration does (sample rows never act). */
export function guidedAction(type: HoldType, declared: DeclaredKind | null): GuidedAction | null {
  if (type === "goods") return "tracking";
  if (type === "service") return "completed";
  if (type === "sample") return null;
  if (declared === "goods") return "tracking";
  if (declared === "service") return "completed";
  return null;
}
