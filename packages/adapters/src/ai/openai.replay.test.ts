// Offline replay of the M0-07 recordings: every recorded response goes back through the adapter
// (zod re-validation included), and the verbatim check runs over every recorded pass-2 output.
// Replay uses the temporary exchange.ts helper until M0-04's src/testing/replay.ts lands.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { checkQuotes } from "@cleared/core/proof/verbatim";
import { replayFetch, type Fixture } from "./exchange.ts";
import { createOpenAiProvider } from "./openai.ts";
import { ExtractResult, ScopeClaims, ScopeVerdicts } from "./schemas.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const FIXTURES = join(ROOT, "fixtures/openai");
const SAMPLES = join(ROOT, "fixtures/samples/evidence");

function load(area: string): { name: string; fixture: Fixture }[] {
  return readdirSync(join(FIXTURES, area))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, fixture: JSON.parse(readFileSync(join(FIXTURES, area, f), "utf8")) as Fixture }));
}

async function replay<S extends z.ZodType>(fixture: Fixture, schema: S, model = "gpt-6.1-terra") {
  const provider = createOpenAiProvider({ apiKey: "replay", fetch: replayFetch(fixture), maxRetries: 0 });
  return provider.generate({
    model,
    schemaName: "replay",
    schema,
    instructions: "",
    task: "",
    evidence: [],
    maxOutputTokens: 1,
  });
}

/** The evidence text each run's quotes are verified against (text items as stored, PDFs by text layer). */
const text = (f: string): string => readFileSync(join(SAMPLES, f), "utf8");
const LOGO = (chat: string) => [
  { id: "E1", text: text("brief-logo.txt") },
  { id: "E2", text: text(chat) },
  { id: "E3", text: text("delivery-logo.pdf.txt") },
];
const EVIDENCE: Record<string, { id: string; text: string }[]> = {
  r1: LOGO("chat-logo.txt"),
  r4: LOGO("chat-logo.txt"),
  r5: LOGO("chat-logo.txt"),
  c1: LOGO("chat-logo-control.txt"),
  r2: [
    { id: "E1", text: text("brief-translation.txt") },
    { id: "E2", text: text("chat-translation.txt") },
    { id: "E3", text: text("delivery-translation.pdf.txt") },
  ],
  r3: [
    { id: "E1", text: text("brief-website.txt") },
    { id: "E2", text: text("chat-website.txt") },
  ],
};

describe("openai replay: every recorded success parses through the zod schemas", () => {
  const cases = [
    { area: "extract", schema: ExtractResult, model: "gpt-6-luna" },
    { area: "scope-pass1", schema: ScopeClaims, model: "gpt-6.1-terra" },
    { area: "scope-pass2", schema: ScopeVerdicts, model: "gpt-6.1-terra" },
  ] as const;
  for (const { area, schema, model } of cases) {
    const fixtures = load(area);
    it(`${area}: ${String(fixtures.length)} fixtures`, async () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(5);
      for (const { name, fixture } of fixtures) {
        const res = await replay(fixture, schema, model);
        expect(res.ok, `${area}/${name}`).toBe(true);
        expect(res.usage?.inputTokens, name).toBeGreaterThan(0);
        expect(res.costUsd, name).toBeGreaterThan(0);
      }
    });
  }
});

describe("openai replay: verbatim check over recorded pass-2 output", () => {
  // Measured on the recordings (docs/evidence/m0-07-openai-spike.md): every quote from a text or
  // PDF item verifies, except the API's own PDF page marker; screenshots have no text layer, so
  // their citations are unverifiable by construction (BL-01, M2-03).
  it("checks every citation; only screenshot citations and the PDF page marker fail", async () => {
    const summary: Record<string, { verified: number; total: number }> = {};
    const failures: string[] = [];
    for (const { name, fixture } of load("scope-pass2")) {
      const run = name.split("-")[0] ?? "";
      const evidence = EVIDENCE[run];
      expect(evidence, `evidence map for ${run}`).toBeDefined();
      const res = await replay(fixture, ScopeVerdicts);
      if (!res.ok || evidence === undefined) throw new Error(`replay failed for ${name}`);
      const refs = res.value.verdicts.flatMap((v) =>
        v.citations.map((c) => ({ evidenceId: c.evidence_id, quote: c.quote })),
      );
      const checks = checkQuotes(refs, evidence);
      expect(checks).toHaveLength(refs.length);
      summary[run] = { verified: checks.filter((c) => c.status === "verified").length, total: checks.length };
      for (const c of checks) {
        if (c.status === "verified") continue;
        const isScreenshot = c.reason === "unknown_evidence" && !evidence.some((e) => e.id === c.evidenceId);
        const isPageMarker = c.reason === "not_found" && /^<PARSED TEXT FOR PAGE: \d+ \/ \d+>$/.test(c.quote);
        if (!isScreenshot && !isPageMarker)
          failures.push(`${name}: ${c.evidenceId} ${JSON.stringify(c.quote)}`);
      }
    }
    expect(Object.keys(summary).sort()).toEqual(Object.keys(EVIDENCE).sort());
    expect(failures).toEqual([]);
    const all = Object.values(summary).reduce(
      (a, s) => ({ verified: a.verified + s.verified, total: a.total + s.total }),
      { verified: 0, total: 0 },
    );
    expect(all).toEqual({ verified: 33, total: 48 });
  });
});

describe("openai replay: error cases", () => {
  const byName = new Map(load("errors").map((e) => [e.name, e.fixture]));
  const get = (n: string): Fixture => {
    const f = byName.get(n);
    if (f === undefined) throw new Error(`missing errors/${n}`);
    return f;
  };

  it("a client timeout surfaces as a transport error, never a verdict", async () => {
    const res = await replay(get("err-timeout-client.json"), ExtractResult);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["timeout", "connection"]).toContain(res.error.kind);
  });

  it("a response cut at max_output_tokens is 'incomplete' and still costs money", async () => {
    const res = await replay(get("err-incomplete-max-output-tokens.json"), ExtractResult, "gpt-6-luna");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ kind: "incomplete", detail: "max_output_tokens" });
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("an unknown model is an http error with its status", async () => {
    const res = await replay(get("err-model-not-found.json"), ExtractResult);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("http");
  });
});

describe("openai fixtures are scrubbed", () => {
  it("carry no credential headers or key-shaped text", () => {
    for (const area of ["extract", "scope-pass1", "scope-pass2", "errors"]) {
      for (const { name, fixture } of load(area)) {
        const raw = JSON.stringify(fixture);
        expect(raw, name).not.toMatch(
          /authorization|openai-organization|openai-project|sk-[A-Za-z0-9_-]{20,}/i,
        );
        expect(fixture.meta.scrubbed, name).toBe(true);
      }
    }
  });
});
