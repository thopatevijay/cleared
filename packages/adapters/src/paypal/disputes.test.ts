// Client-side guards of the Disputes client: file and notes limits, multipart shape, links-only
// actions and outcome wording. Every refusal here happens before any HTTP call (a counting fetch proves it).
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client.ts";
import {
  allowedActions,
  buildMultipart,
  checkEvidenceFiles,
  checkNotes,
  createPayPalDisputesClient,
  describeOutcome,
  EVIDENCE_LIMITS,
  EvidenceRejectedError,
  type EvidenceFile,
} from "./disputes.ts";
import type { TokenProvider } from "./token.ts";

const MB = 1_000_000;
const file = (name: string, bytes: number): EvidenceFile => ({ name, bytes: new Uint8Array(bytes) });

function rejectCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    if (err instanceof EvidenceRejectedError) return err.code;
    throw err;
  }
  return undefined;
}

/** A client whose fetch counts calls and answers nothing: any HTTP call fails the test's count check. */
function countingClient() {
  const calls: string[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetch: (input) => {
      calls.push(String(input));
      return Promise.reject(new Error("no network in this test"));
    },
  });
  const tokens: TokenProvider = {
    getToken: () => Promise.resolve({ value: "t", expiresAt: Date.now() + 60_000, scopes: [], appId: undefined }),
    invalidate: () => undefined,
    withToken: (call) => call("t"),
  };
  return { dc: createPayPalDisputesClient({ http, tokens, env: () => "sandbox" }), calls };
}

describe("evidence guards (PayPal's published limits)", () => {
  it.each(["note.docx", "proof.exe", "scan.tiff", "noextension", "pdf"])("rejects the file type of %s", (name) => {
    expect(rejectCode(() => checkEvidenceFiles([file(name, 10)]))).toBe("FILE_TYPE");
  });

  it.each(["a.jpg", "a.JPEG", "a.gif", "a.png", "a.pdf"])("accepts %s", (name) => {
    expect(rejectCode(() => checkEvidenceFiles([file(name, 10)]))).toBeUndefined();
  });

  it("rejects a file of 10 MB or more; accepts one just under", () => {
    expect(rejectCode(() => checkEvidenceFiles([file("a.pdf", 10 * MB)]))).toBe("FILE_TOO_LARGE");
    expect(rejectCode(() => checkEvidenceFiles([file("a.pdf", 10 * MB - 1)]))).toBeUndefined();
  });

  it("rejects more than 50 MB in one call; accepts exactly 50 MB", () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`p${String(i)}.pdf`, 9 * MB));
    expect(rejectCode(() => checkEvidenceFiles(six))).toBe("TOTAL_TOO_LARGE");
    const five = Array.from({ length: 5 }, (_, i) => file(`p${String(i)}.png`, 10 * MB - 1));
    const exact = [...five, file("q.gif", 5)];
    expect(exact.reduce((n, f) => n + f.bytes.byteLength, 0)).toBe(50 * MB);
    expect(rejectCode(() => checkEvidenceFiles(exact))).toBeUndefined();
  });

  it("rejects an empty file", () => {
    expect(rejectCode(() => checkEvidenceFiles([file("a.pdf", 0)]))).toBe("EMPTY");
  });

  it("notes: 2000 characters pass, 2001 are rejected", () => {
    expect(rejectCode(() => checkNotes("x".repeat(EVIDENCE_LIMITS.maxNotesChars)))).toBeUndefined();
    expect(rejectCode(() => checkNotes("x".repeat(2001)))).toBe("NOTES_TOO_LONG");
  });

  it("the client refuses bad evidence before any HTTP call", async () => {
    const { dc, calls } = countingClient();
    const o = { requestId: "r-1" };
    await expect(dc.provideEvidence("PP-D-1", { evidenceType: "OTHER", files: [file("a.docx", 5)] }, o)).rejects.toThrow(EvidenceRejectedError);
    await expect(dc.provideEvidence("PP-D-1", { evidenceType: "OTHER", files: [file("a.pdf", 10 * MB)] }, o)).rejects.toThrow(EvidenceRejectedError);
    await expect(dc.provideSupportingInfo("PP-D-1", { notes: "x".repeat(2001) }, o)).rejects.toThrow(EvidenceRejectedError);
    await expect(dc.acceptClaim("PP-D-1", { note: "x".repeat(2001) }, o)).rejects.toThrow(EvidenceRejectedError);
    expect(calls).toEqual([]);
  });
});

describe("buildMultipart", () => {
  it("sends an input JSON part and the file bytes intact; the preview carries no bytes", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 binary\u0000ÿ");
    const m = buildMultipart({ evidences: [{ evidence_type: "OTHER" }] }, [{ name: "d.pdf", bytes }], "BOUNDARY");
    const text = Buffer.from(m.body).toString("latin1");
    expect(m.contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    expect(text).toContain('name="input"\r\nContent-Type: application/json\r\n\r\n{"evidences":[{"evidence_type":"OTHER"}]}');
    expect(text).toContain('name="file1"; filename="d.pdf"\r\nContent-Type: application/pdf');
    expect(Buffer.from(m.body).includes(Buffer.from(bytes))).toBe(true);
    expect(text.endsWith("--BOUNDARY--\r\n")).toBe(true);
    expect(m.preview).toMatch(/\[application\/pdf \d+ bytes sha256:[0-9a-f]{64}\]/);
    expect(m.preview).not.toContain("%PDF");
  });
});

describe("allowedActions", () => {
  const links = (...rels: string[]) => rels.map((rel) => ({ rel, href: `https://x/${rel}`, method: "POST" }));

  it("comes only from links[].rel: navigation and unknown rels are ignored", () => {
    expect(allowedActions({ links: links("self", "up", "provide_evidence", "accept_claim", "something_new") })).toEqual(["provide_evidence", "accept_claim"]);
    expect(allowedActions({ links: links("self") })).toEqual([]);
  });
});

describe("describeOutcome", () => {
  const resolved = (outcome_code: "RESOLVED_WITH_PAYOUT" | "RESOLVED_BUYER_FAVOUR", outcome_reason?: string) =>
    describeOutcome({ status: "RESOLVED", dispute_outcome: { outcome_code, ...(outcome_reason === undefined ? {} : { outcome_reason }) } });

  it("RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL → seller keeps the money (PayPal covered the case)", () => {
    expect(resolved("RESOLVED_WITH_PAYOUT", "REPRESENTED_BY_PAYPAL")).toEqual({
      kind: "seller_keeps_paypal_covered",
      text: "seller keeps the money (PayPal covered the case)",
    });
  });

  it("a payout without PayPal's representation is not claimed as the seller's", () => {
    expect(resolved("RESOLVED_WITH_PAYOUT", "SOMETHING_ELSE").kind).toBe("unmapped");
    expect(resolved("RESOLVED_BUYER_FAVOUR").kind).toBe("buyer_refunded");
    expect(describeOutcome({ status: "UNDER_REVIEW" }).kind).toBe("open");
  });
});
