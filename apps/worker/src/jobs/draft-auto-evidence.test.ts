// BL-01 6595501766: which client sign-off / scope snapshot code adds to the agent's selection, and what it
// leaves out on PayPal's per-file limits (jpg/gif/png/pdf or text; < 10 MB).
import { describe, expect, it } from "vitest";
import { planAutoEvidence, type AutoCandidateSource } from "./draft-auto-evidence.ts";

const item = (id: string, kind: string, over: Partial<AutoCandidateSource> = {}): AutoCandidateSource => ({
  id,
  kind,
  mime: null,
  size: null,
  text: "t",
  ...over,
});

describe("planAutoEvidence", () => {
  const pack = [
    item("brief", "scope"),
    item("ack-old", "client_ack"),
    item("snap", "scope_snapshot", { mime: "application/pdf", size: 40_000, text: null }),
    item("ack-new", "client_ack"),
  ];

  it("adds the newest item of each kind the selection lacks, in pack order", () => {
    const plan = planAutoEvidence(pack, new Set(["brief"]));
    expect(plan.candidates.map((c) => c.id)).toEqual(["snap", "ack-new"]);
    expect(plan.leftOut).toEqual([]);
  });

  it("adds nothing for a kind the model already selected (any item of it)", () => {
    const plan = planAutoEvidence(pack, new Set(["ack-old"]));
    expect(plan.candidates.map((c) => c.id)).toEqual(["snap"]);
  });

  it("adds nothing when the pack has neither kind", () => {
    expect(planAutoEvidence([item("brief", "scope")], new Set())).toEqual({ candidates: [], leftOut: [] });
  });

  it("leaves out, with a code, a type PayPal refuses and a file of 10 MB or more", () => {
    const plan = planAutoEvidence(
      [
        item("ack", "client_ack", { mime: "image/webp", size: 1_000, text: null }),
        item("snap", "scope_snapshot", { mime: "application/pdf", size: 10_000_000, text: null }),
      ],
      new Set(),
    );
    expect(plan.candidates).toEqual([]);
    expect(plan.leftOut).toEqual([
      { id: "ack", kind: "client_ack", code: "unsupported_type", bytes: 1_000 },
      { id: "snap", kind: "scope_snapshot", code: "file_too_large", bytes: 10_000_000 },
    ]);
  });

  it("accepts every PayPal type (jpg, gif, png, pdf) and text just under the limit", () => {
    for (const mime of ["image/jpeg", "image/gif", "image/png", "application/pdf"]) {
      const plan = planAutoEvidence(
        [item("s", "scope_snapshot", { mime, size: 9_999_999, text: null })],
        new Set(),
      );
      expect(
        plan.candidates.map((c) => c.id),
        mime,
      ).toEqual(["s"]);
    }
    expect(
      planAutoEvidence([item("a", "client_ack", { text: "x".repeat(500) })], new Set()).candidates,
    ).toHaveLength(1);
  });
});
