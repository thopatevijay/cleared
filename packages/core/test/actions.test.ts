import { describe, expect, it } from "vitest";
import {
  addMinutes,
  canExecute,
  canonicalJson,
  parseInstant,
  type ActionId,
  type Approval,
  type ExecutionContext,
  type Instant,
  type ProposedAction,
  type Sha256,
} from "../src/index.ts";

const HASH = "a".repeat(64) as Sha256;
const OTHER = "b".repeat(64) as Sha256;
const ACTION_ID = "6f1c1d2e-0a4b-4c8d-9e7f-1a2b3c4d5e6f" as ActionId;

function instant(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const due = instant("2026-11-09T04:59:59.000Z"); // seller_response_due_date from disputes/full state-3
const action = {
  id: ACTION_ID,
  workspaceId: "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b",
  kind: "provide_evidence",
  disputeId: "PP-R-UVC-10195076",
  payload: { notes: "Delivered on 4 Oct" },
  payloadSha256: HASH,
  state: "approved",
  risk: "medium",
  createdByRunId: null,
} as unknown as ProposedAction;
const approval: Approval = {
  actionId: ACTION_ID,
  approvedBy: "seller",
  approvedAt: instant("2026-11-01T00:00:00Z"),
  payloadSha256: HASH,
};

function ctx(over: Partial<ExecutionContext>): ExecutionContext {
  return {
    now: addMinutes(due, -61),
    dueDate: due,
    hasActionLink: true,
    approval,
    payloadSha256: HASH,
    killSwitch: false,
    ...over,
  };
}

describe("canExecute: the deadline (seller_response_due_date − 1 h)", () => {
  it("allows at due − 61 min", () => {
    expect(canExecute(action, ctx({ now: addMinutes(due, -61) }))).toEqual({ kind: "allow" });
  });
  it("refuses at due − 1 h exactly", () => {
    expect(canExecute(action, ctx({ now: addMinutes(due, -60) }))).toEqual({
      kind: "refuse",
      reason: "past_deadline",
    });
  });
  it("refuses at due − 59 min", () => {
    expect(canExecute(action, ctx({ now: addMinutes(due, -59) }))).toEqual({
      kind: "refuse",
      reason: "past_deadline",
    });
  });
  it("refuses one millisecond after the cutoff and after the due date", () => {
    const cutoff = addMinutes(due, -60);
    expect(canExecute(action, ctx({ now: instant(cutoff.replace(".000Z", ".001Z")) })).kind).toBe("refuse");
    expect(canExecute(action, ctx({ now: addMinutes(due, 5) })).kind).toBe("refuse");
  });
  it("has no deadline check when the action has no due date", () => {
    expect(canExecute(action, ctx({ dueDate: null, now: addMinutes(due, 600) }))).toEqual({ kind: "allow" });
  });
});

describe("canExecute: other refusals", () => {
  it.each([
    ["no HATEOAS link", ctx({ hasActionLink: false }), action, "no_action_link"],
    ["the payload hash about to be sent differs", ctx({ payloadSha256: OTHER }), action, "hash_mismatch"],
    [
      "the approval is for another hash",
      ctx({ approval: { ...approval, payloadSha256: OTHER } }),
      action,
      "hash_mismatch",
    ],
    ["the kill switch is on", ctx({ killSwitch: true }), action, "kill_switch_on"],
    ["there is no approval", ctx({ approval: null }), action, "no_approval"],
    [
      "the approval is for another action",
      ctx({ approval: { ...approval, actionId: "00000000-0000-4000-8000-000000000000" as ActionId } }),
      action,
      "no_approval",
    ],
    ["the action is only proposed", ctx({}), { ...action, state: "proposed" }, "not_approved"],
    [
      "the action is in unknown (reconcile, never re-send)",
      ctx({}),
      { ...action, state: "unknown" },
      "not_approved",
    ],
  ] as const)("refuses when %s", (_name, context, act, reason) => {
    expect(canExecute(act, context)).toEqual({ kind: "refuse", reason });
  });

  it("the kill switch wins over everything else", () => {
    expect(canExecute(action, ctx({ killSwitch: true, hasActionLink: false, approval: null })).kind).toBe(
      "refuse",
    );
    expect(canExecute(action, ctx({ killSwitch: true, hasActionLink: false }))).toEqual({
      kind: "refuse",
      reason: "kill_switch_on",
    });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });
  it("gives the same string whatever the key order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it("skips undefined values like JSON.stringify, keeps array order", () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });
  it("escapes strings exactly like JSON", () => {
    expect(canonicalJson({ 'q"k': "line\nbreak é" })).toBe(JSON.stringify({ 'q"k': "line\nbreak é" }));
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson(false)).toBe("false");
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});
