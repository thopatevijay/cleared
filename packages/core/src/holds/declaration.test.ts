// BL-01 6570499264 (option A, ADR 0017 addendum 3): the seller's declaration selects the guided action and
// never PayPal's release rule. The hard rule from the #35 research: on a PENDING_REVIEW hold (or any hold
// PayPal didn't type goods/service) no declaration, filed tracking or Completed confirmation yields the
// goods_delivered ("~24 h after delivery") or service_completed ("7 days after Completed") estimate.
import { describe, expect, it } from "vitest";
import { ACTION_STATES } from "../actions/state.ts";
import { parseInstant, type Instant } from "../time.ts";
import { confirmCompleted } from "./completed.ts";
import {
  canDeclare,
  decideDeclaration,
  declarationLocked,
  declaredKindOf,
  DECLARED_KINDS,
  DeclareBodySchema,
  GUIDED_ACTIONS,
  guidedAction,
  holdTypeOf,
  releaseRuleAfterAction,
  type LockFacts,
} from "./declaration.ts";
import { deriveHold } from "./derive.ts";
import { HOLD_RULES, HOLD_TYPES, ruleForReason } from "./rules.ts";
import { HOLD_STATES } from "./state.ts";

function at(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
}

const SEEN = at("2026-10-26T11:24:21.000Z");
const NOW = at("2026-10-27T09:00:00.000Z");
/** Every capture reason PayPal can hold with (the rule table's reason rows). */
const REASONS = HOLD_RULES.flatMap((r) => (r.appliesTo.kind === "reason" ? r.appliesTo.reasons : []));
const DELIVERY_RULES = new Set(["goods_delivered", "service_completed"]);

const lock = (o: Partial<LockFacts> = {}): LockFacts => ({
  state: "open",
  completedConfirmed: false,
  actionStates: [],
  ...o,
});

describe("guidedAction: PayPal's type first, else the seller's declaration", () => {
  it("PayPal-typed goods/service holds pick their own action whatever the declaration", () => {
    for (const d of [null, ...DECLARED_KINDS]) {
      expect(guidedAction("goods", d)).toBe("tracking");
      expect(guidedAction("service", d)).toBe("completed");
      expect(guidedAction("sample", d)).toBeNull();
    }
  });

  it("review / dispute / other holds follow the declaration; undeclared → nothing to do", () => {
    for (const type of ["review", "dispute", "other"] as const) {
      expect(guidedAction(type, null)).toBeNull();
      expect(guidedAction(type, "goods")).toBe("tracking");
      expect(guidedAction(type, "service")).toBe("completed");
    }
  });

  it("stored values parse defensively", () => {
    expect(holdTypeOf("review")).toBe("review");
    expect(holdTypeOf("made_up")).toBe("other");
    expect(declaredKindOf("goods")).toBe("goods");
    expect(declaredKindOf("parcel")).toBeNull();
    expect(declaredKindOf(null)).toBeNull();
    expect(DeclareBodySchema.safeParse({ kind: "goods" }).success).toBe(true);
    expect(DeclareBodySchema.safeParse({ kind: "digital" }).success).toBe(false);
    expect(DeclareBodySchema.safeParse({ kind: "goods", type: "goods" }).success).toBe(false);
  });
});

describe("the hard rule: a release rule follows PayPal's type, never the declaration", () => {
  it("only PayPal-typed goods/service holds may switch to the delivery/Completed rules", () => {
    for (const type of HOLD_TYPES)
      for (const action of GUIDED_ACTIONS) {
        const rule = releaseRuleAfterAction(type, action);
        if (type === "goods" && action === "tracking") expect(rule?.id).toBe("goods_delivered");
        else if (type === "service" && action === "completed") expect(rule?.id).toBe("service_completed");
        else expect(rule).toBeNull();
      }
  });

  it("every PayPal reason: the derived hold keeps PayPal's rule after any declaration and any action", () => {
    for (const reason of REASONS) {
      const hold = deriveHold({ status: "PENDING", reason, updateTime: SEEN });
      if (hold === null) throw new Error(reason);
      expect(hold.estimateRuleId).toBe(ruleForReason(reason).id);
      expect(DELIVERY_RULES.has(hold.estimateRuleId)).toBe(false);
      for (const declared of DECLARED_KINDS) {
        const action = guidedAction(hold.type, declared);
        expect(action).not.toBeNull();
        if (action === null) continue;
        expect(releaseRuleAfterAction(hold.type, action)).toBeNull();
      }
    }
  });

  it("PENDING_REVIEW declared a service: Completed is confirmed, the hold files, the estimate stays payment_review", () => {
    const review = deriveHold({ status: "PENDING", reason: "PENDING_REVIEW", updateTime: SEEN });
    expect(review?.estimateRuleId).toBe("payment_review");
    expect(review?.estimatedReleaseAt).toBe("2026-10-27T11:24:21.000Z"); // PayPal's ~24 h review rule
    const r = confirmCompleted({
      hold: { type: "review", state: "open", openedAt: SEEN, completedConfirmedAt: null },
      declared: "service",
      confirmedOn: "2026-10-27",
      now: NOW,
      timeZone: "UTC",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({ confirmedAt: NOW, state: "filed", estimate: null, ruleId: null });
  });

  it("an undeclared (or goods-declared) review hold can't take the Completed step", () => {
    const base = {
      hold: { type: "review" as const, state: "open" as const, openedAt: SEEN, completedConfirmedAt: null },
      confirmedOn: "2026-10-27",
      now: NOW,
      timeZone: "UTC",
    };
    expect(confirmCompleted({ ...base, declared: null })).toEqual({ ok: false, error: "NOT_SERVICE_HOLD" });
    expect(confirmCompleted({ ...base, declared: "goods" })).toEqual({
      ok: false,
      error: "NOT_SERVICE_HOLD",
    });
  });

  it("a PayPal-typed service hold still gets help129's 7 days (M3-04 unchanged)", () => {
    const r = confirmCompleted({
      hold: { type: "service", state: "open", openedAt: SEEN, completedConfirmedAt: null },
      declared: null,
      confirmedOn: "2026-10-27",
      now: NOW,
      timeZone: "UTC",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.ruleId).toBe("service_completed");
    expect(r.value.estimate?.at).toBe("2026-11-03T09:00:00.000Z");
  });
});

describe("declaring and the lock", () => {
  it("declarable: unreleased holds PayPal didn't type goods/service, never samples", () => {
    for (const state of HOLD_STATES)
      for (const type of HOLD_TYPES) {
        const ok = state !== "released" && ["review", "dispute", "other"].includes(type);
        expect(canDeclare(type, state)).toBe(ok);
      }
  });

  it("locked after approval: hold past approval, Completed confirmed, or an approved-or-later action", () => {
    for (const state of HOLD_STATES)
      expect(declarationLocked(lock({ state }))).toBe(
        ["approved", "filed", "still_held", "released"].includes(state),
      );
    expect(declarationLocked(lock({ completedConfirmed: true }))).toBe(true);
    for (const s of ACTION_STATES)
      expect(declarationLocked(lock({ actionStates: [s] }))).toBe(!["proposed", "rejected"].includes(s));
  });

  it("decideDeclaration: set, change, keep (idempotent), refuse when locked or not declarable", () => {
    const d = (o: Partial<Parameters<typeof decideDeclaration>[0]>) =>
      decideDeclaration({ type: "review", lock: lock(), current: null, next: "goods", ...o });
    expect(d({})).toEqual({ ok: true, value: { changed: true } });
    expect(d({ current: "goods", next: "service" })).toEqual({ ok: true, value: { changed: true } });
    expect(d({ current: "goods", lock: lock({ actionStates: ["proposed"] }) })).toEqual({
      ok: true,
      value: { changed: false },
    });
    expect(d({ current: "goods", next: "service", lock: lock({ actionStates: ["succeeded"] }) })).toEqual({
      ok: false,
      error: "DECLARATION_LOCKED",
    });
    expect(d({ type: "goods" })).toEqual({ ok: false, error: "NOT_DECLARABLE" });
    expect(d({ lock: lock({ state: "released" }) })).toEqual({ ok: false, error: "NOT_DECLARABLE" });
  });
});
