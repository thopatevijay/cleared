// M2-08: approval policy in code (ADR 0010): hash binding, kinds, payloads, accept_claim rules.
import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  checkApproval,
  EXECUTABLE_KINDS,
  isExecutableKind,
  parseExecutablePayload,
  typedConfirmationFor,
  type ApprovalSubject,
} from "../index.ts";

const evidencePayload = {
  dispute_id: "PP-R-UVC-10195076",
  evidence_type: "PROOF_OF_FULFILLMENT",
  notes: "Delivered on 4 Oct; the signed delivery note is attached.",
  compiled_blob_sha256: "1cfdd3fb2b074dcf23e3160af91a88fdda2a2d812693cf07d5d2ea527efdc52f",
  draft_id: "6f1c1d2e-0a4b-4c8d-9e7f-1a2b3c4d5e6f",
};
const acceptPayload = {
  dispute_id: "PP-R-ARH-10195077",
  note: "Refunding the buyer in full.",
  amount: { value: "120.00", currency_code: "USD" },
  accept_claim_type: "REFUND",
};

function subject(over: Partial<ApprovalSubject> = {}): ApprovalSubject {
  const payload = over.payload ?? evidencePayload;
  return {
    kind: "provide_evidence",
    state: "proposed",
    payload,
    payloadSha256: canonicalHash(payload as never),
    createdByRunId: "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b",
    ...over,
  };
}

const acceptSubject = (over: Partial<ApprovalSubject> = {}): ApprovalSubject =>
  subject({ kind: "accept_claim", payload: acceptPayload, createdByRunId: null, ...over });

describe("checkApproval (M2-08 policy)", () => {
  it("allows a proposed action approved with its exact hash", () => {
    const s = subject();
    const d = checkApproval(s, { payloadSha256: s.payloadSha256 });
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") expect(d.executable.kind).toBe("provide_evidence");
  });

  it("a stale hash → APPROVAL_HASH_MISMATCH", () => {
    const s = subject();
    const stale = canonicalHash({ ...evidencePayload, notes: "an older draft" });
    expect(checkApproval(s, { payloadSha256: stale })).toEqual({
      kind: "refuse",
      code: "APPROVAL_HASH_MISMATCH",
    });
  });

  it("only `proposed` can be approved", () => {
    for (const state of ["approved", "rejected", "executing", "succeeded", "failed", "unknown"] as const) {
      const s = subject({ state });
      expect(checkApproval(s, { payloadSha256: s.payloadSha256 })).toEqual({
        kind: "refuse",
        code: "ACTION_NOT_PROPOSED",
      });
    }
  });

  it("unknown or not-yet-executable kinds are refused", () => {
    for (const kind of ["add_tracking", "make_offer", "escalate"]) {
      const s = subject({ kind });
      expect(checkApproval(s, { payloadSha256: s.payloadSha256 })).toEqual({
        kind: "refuse",
        code: "UNKNOWN_ACTION_KIND",
      });
    }
  });

  it("a payload that does not parse for its kind → INVALID_PAYLOAD", () => {
    const s = subject({ payload: { ...evidencePayload, notes: "x".repeat(2001) } });
    expect(checkApproval(s, { payloadSha256: s.payloadSha256 })).toEqual({
      kind: "refuse",
      code: "INVALID_PAYLOAD",
    });
  });

  it("accept_claim created by an agent run is refused, even with the right confirmation", () => {
    const s = acceptSubject({ createdByRunId: "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b" });
    expect(checkApproval(s, { payloadSha256: s.payloadSha256, typedConfirmation: "120.00 USD" })).toEqual({
      kind: "refuse",
      code: "AGENT_ACCEPT_CLAIM_FORBIDDEN",
    });
  });

  it("seller-created accept_claim needs the exact typed amount + currency", () => {
    const s = acceptSubject();
    const approve = (typedConfirmation?: string) =>
      checkApproval(s, { payloadSha256: s.payloadSha256, typedConfirmation });
    expect(approve()).toEqual({ kind: "refuse", code: "TYPED_CONFIRMATION_REQUIRED" });
    expect(approve("")).toEqual({ kind: "refuse", code: "TYPED_CONFIRMATION_REQUIRED" });
    for (const wrong of ["120 USD", "120.00", "120.00 usd", "USD 120.00", " 120.00 USD", "120.01 USD"]) {
      expect(approve(wrong)).toEqual({ kind: "refuse", code: "TYPED_CONFIRMATION_MISMATCH" });
    }
    expect(approve("120.00 USD").kind).toBe("allow");
  });
});

describe("executable payloads", () => {
  it("the executable kinds are the three dispute writes", () => {
    expect([...EXECUTABLE_KINDS].sort()).toEqual([
      "accept_claim",
      "provide_evidence",
      "provide_supporting_info",
    ]);
    expect(isExecutableKind("add_tracking")).toBe(false);
    expect(isExecutableKind("toString")).toBe(false);
  });

  it("supporting info: notes alone, or notes with both blob fields", () => {
    const base = { dispute_id: "PP-R-UVC-10195076", notes: "More context." };
    expect(parseExecutablePayload("provide_supporting_info", base)?.kind).toBe("provide_supporting_info");
    expect(
      parseExecutablePayload("provide_supporting_info", {
        ...base,
        compiled_blob_sha256: evidencePayload.compiled_blob_sha256,
      }),
    ).toBeNull();
    expect(
      parseExecutablePayload("provide_supporting_info", {
        ...base,
        compiled_blob_sha256: evidencePayload.compiled_blob_sha256,
        draft_id: evidencePayload.draft_id,
      })?.kind,
    ).toBe("provide_supporting_info");
  });

  it("accept_claim: REFUND only, PayPal money shape", () => {
    expect(parseExecutablePayload("accept_claim", acceptPayload)?.kind).toBe("accept_claim");
    expect(
      parseExecutablePayload("accept_claim", { ...acceptPayload, accept_claim_type: "PARTIAL" }),
    ).toBeNull();
    expect(
      parseExecutablePayload("accept_claim", {
        ...acceptPayload,
        amount: { value: "1e3", currency_code: "USD" },
      }),
    ).toBeNull();
    expect(parseExecutablePayload("nope", acceptPayload)).toBeNull();
  });

  it("typed confirmation is the amount as displayed", () => {
    expect(typedConfirmationFor({ value: "64.00", currency_code: "USD" })).toBe("64.00 USD");
  });
});
