import { describe, expect, it } from "vitest";
import {
  checkDraftLimits,
  DISPUTE_NOTES_MAX_CHARS,
  EVIDENCE_FILE_MAX_BYTES,
  mapDisputeState,
  mirroredRaw,
  parseInstant,
} from "../src/index.ts";
import { disputeBodies } from "./helpers/fixtures.ts";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

describe("PayPal dispute mirror against the recorded sandbox fixtures (M0-05)", () => {
  const bodies = disputeBodies("disputes");

  it("finds the dispute bodies (34 recorded GET/list responses)", () => {
    expect(bodies.length).toBe(34);
  });

  it.each(bodies.map((b) => [b.file, b.body] as const))("%s maps with no unrecognised value", (_f, body) => {
    const outcome = body.dispute_outcome as { outcome_code?: string } | undefined;
    const state = mapDisputeState({
      status: str(body.status) ?? "",
      stage: str(body.dispute_life_cycle_stage),
      outcomeCode: outcome?.outcome_code ?? null,
    });
    expect(state.status.kind).toBe("known");
    expect(mirroredRaw(state.status)).toBe(body.status);
    expect(state.stage?.kind).toBe("known");
    if (state.outcome !== null) expect(state.outcome.kind).toBe("known");
    const due = str(body.seller_response_due_date);
    if (due !== null) expect(parseInstant(due).ok).toBe(true);
  });

  it("keeps an unknown status verbatim; null stage and outcome stay null", () => {
    expect(mapDisputeState({ status: "APPEALABLE", stage: null, outcomeCode: null })).toEqual({
      status: { kind: "unrecognised", raw: "APPEALABLE" },
      stage: null,
      outcome: null,
    });
  });
});

describe("dispute draft limits (PayPal evidence rules)", () => {
  const pdf = { mime: "application/pdf", sizeBytes: 1_000 };

  it("accepts notes of exactly 2000 chars and allowed files", () => {
    expect(
      checkDraftLimits("a".repeat(DISPUTE_NOTES_MAX_CHARS), [pdf, { mime: "image/png", sizeBytes: 5 }]),
    ).toEqual({
      ok: true,
      value: true,
    });
  });

  it.each([
    ["notes over 2000 chars", "a".repeat(2001), [pdf], "notes exceed 2000 characters"],
    [
      "a docx",
      "",
      [{ mime: "application/msword", sizeBytes: 1 }],
      "evidence file type not accepted by PayPal",
    ],
    [
      "a 10 MB file",
      "",
      [{ mime: "image/jpeg", sizeBytes: EVIDENCE_FILE_MAX_BYTES }],
      "evidence file must be under 10 MB",
    ],
    [
      "over 50 MB per call",
      "",
      Array.from({ length: 6 }, () => ({ mime: "image/gif", sizeBytes: EVIDENCE_FILE_MAX_BYTES - 1 })),
      "evidence files exceed 50 MB per call",
    ],
  ])("refuses %s", (_name, notes, files, message) => {
    const r = checkDraftLimits(notes, files);
    expect(r.ok ? null : [r.error.code, r.error.message]).toEqual(["invariant_violated", message]);
  });
});
