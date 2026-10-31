// M2-08: the ordered execution checks, the send-outcome classification and the reconcile verdict.
import { describe, expect, it } from "vitest";
import {
  addMinutes,
  checkActionLink,
  checkBlobHash,
  checkDeadline,
  checkKillSwitch,
  checkOwnership,
  checkPayloadHash,
  classifySendFailure,
  EXECUTION_CHECKS,
  parseInstant,
  RECONCILE_MAX_TRIES,
  reconcileDelaySeconds,
  reconcileVerdict,
  type Instant,
  type Sha256,
} from "../index.ts";

const A = "a".repeat(64) as Sha256;
const B = "b".repeat(64) as Sha256;
const WS = "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b";

function instant(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const due = instant("2026-11-09T04:59:59.000Z"); // disputes/full state-3

describe("execution checks (M2-08), in the ticket's order", () => {
  it("the order is kill switch, payload hash, blob hash, ownership, action link, deadline", () => {
    expect(EXECUTION_CHECKS).toEqual([
      "kill_switch",
      "payload_hash",
      "blob_hash",
      "ownership",
      "action_link",
      "deadline",
    ]);
  });

  it("kill switch", () => {
    expect(checkKillSwitch(false)).toEqual({ check: "kill_switch", ok: true });
    expect(checkKillSwitch(true)).toEqual({ check: "kill_switch", ok: false, code: "KILL_SWITCH" });
  });

  it("payload hash: recomputed must equal the approved and the stored hash", () => {
    expect(checkPayloadHash({ recomputed: A, approved: A, stored: A }).ok).toBe(true);
    expect(checkPayloadHash({ recomputed: B, approved: A, stored: A })).toMatchObject({
      code: "PAYLOAD_CHANGED",
    });
    expect(checkPayloadHash({ recomputed: A, approved: B, stored: A })).toMatchObject({
      code: "PAYLOAD_CHANGED",
    });
    expect(checkPayloadHash({ recomputed: A, approved: A, stored: B })).toMatchObject({
      code: "PAYLOAD_CHANGED",
    });
  });

  it("blob hash: no blob passes; a changed or missing blob fails", () => {
    expect(checkBlobHash({ expected: null, actual: null }).ok).toBe(true);
    expect(checkBlobHash({ expected: A, actual: A }).ok).toBe(true);
    expect(checkBlobHash({ expected: A, actual: B })).toMatchObject({ code: "BLOB_CHANGED" });
    expect(checkBlobHash({ expected: A, actual: null })).toMatchObject({ code: "BLOB_CHANGED" });
  });

  it("ownership: the dispute's owner row must be the action's workspace", () => {
    expect(checkOwnership({ actionWorkspaceId: WS, ownerWorkspaceId: WS }).ok).toBe(true);
    expect(checkOwnership({ actionWorkspaceId: WS, ownerWorkspaceId: null })).toMatchObject({
      code: "NOT_OWNED",
    });
    expect(checkOwnership({ actionWorkspaceId: WS, ownerWorkspaceId: "other" })).toMatchObject({
      code: "NOT_OWNED",
    });
  });

  it("action link: the kind's rel among the re-fetched links", () => {
    expect(
      checkActionLink({ kind: "provide_evidence", allowedActions: ["accept_claim", "provide_evidence"] }).ok,
    ).toBe(true);
    expect(
      checkActionLink({ kind: "provide_evidence", allowedActions: ["provide_supporting_info"] }),
    ).toMatchObject({
      code: "ACTION_LINK_MISSING",
    });
  });

  it("deadline: allowed at due − 61 min, refused at due − 60 min and due − 59 min, no due date passes", () => {
    expect(checkDeadline({ now: addMinutes(due, -61), dueDate: due }).ok).toBe(true);
    expect(checkDeadline({ now: addMinutes(due, -60), dueDate: due })).toMatchObject({
      code: "DEADLINE_PASSED",
    });
    expect(checkDeadline({ now: addMinutes(due, -59), dueDate: due })).toMatchObject({
      code: "DEADLINE_PASSED",
    });
    expect(checkDeadline({ now: addMinutes(due, 600), dueDate: null }).ok).toBe(true);
  });
});

describe("send outcome", () => {
  it("nothing sent → PAYPAL_UNAVAILABLE; link gone at the client re-check → ACTION_LINK_MISSING", () => {
    expect(classifySendFailure({ kind: "not_sent" })).toEqual({ next: "failed", code: "PAYPAL_UNAVAILABLE" });
    expect(classifySendFailure({ kind: "link_missing" })).toEqual({
      next: "failed",
      code: "ACTION_LINK_MISSING",
    });
  });
  it("4xx → failed PAYPAL_REJECTED; 5xx or no answer → unknown", () => {
    expect(classifySendFailure({ kind: "status", status: 422 })).toEqual({
      next: "failed",
      code: "PAYPAL_REJECTED",
    });
    expect(classifySendFailure({ kind: "status", status: 400 })).toEqual({
      next: "failed",
      code: "PAYPAL_REJECTED",
    });
    expect(classifySendFailure({ kind: "status", status: 503 })).toEqual({ next: "unknown" });
    expect(classifySendFailure({ kind: "no_answer" })).toEqual({ next: "unknown" });
  });
});

describe("reconcile", () => {
  const before = {
    status: "WAITING_FOR_SELLER_RESPONSE",
    allowedActions: ["accept_claim", "provide_evidence"],
    sellerSubmissions: 1,
  };

  it("5 tries, 2 min first, then doubling", () => {
    expect(RECONCILE_MAX_TRIES).toBe(5);
    expect([1, 2, 3, 4, 5].map(reconcileDelaySeconds)).toEqual([120, 240, 480, 960, 1920]);
    expect(reconcileDelaySeconds(0)).toBe(120);
  });

  it("link gone and status moved → landed (disputes/full state-3 → state-4)", () => {
    const after = {
      status: "UNDER_REVIEW",
      allowedActions: ["adjudicate", "provide_supporting_info", "require_evidence"],
      sellerSubmissions: 2,
    };
    expect(reconcileVerdict("provide_evidence", before, after)).toBe("landed");
  });

  it("our submission listed → landed, even with the link still there", () => {
    expect(reconcileVerdict("provide_evidence", before, { ...before, sellerSubmissions: 2 })).toBe("landed");
  });

  it("unchanged → not landed; link gone with the same status → not landed", () => {
    expect(reconcileVerdict("provide_evidence", before, before)).toBe("not_landed");
    expect(
      reconcileVerdict("provide_evidence", before, { ...before, allowedActions: ["accept_claim"] }),
    ).toBe("not_landed");
  });

  it("unknown submission counts never prove a landing on their own", () => {
    const b = { ...before, sellerSubmissions: null };
    expect(reconcileVerdict("provide_evidence", b, { ...before, sellerSubmissions: 5 })).toBe("not_landed");
    expect(
      reconcileVerdict("accept_claim", b, {
        status: "RESOLVED",
        allowedActions: [],
        sellerSubmissions: null,
      }),
    ).toBe("landed");
  });
});
