// Offline replay of the M0-07 recordings through M0-04's msw replay helper: every recorded response
// goes back through the adapter and the shared HTTP client (zod re-validation included), and the
// verbatim check runs over every recorded pass-2 output.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { checkQuotes } from "@cleared/core/proof/verbatim";
import { createHttpClient } from "../http/client.ts";
import { FIXTURES_DIR, loadFixture } from "../testing/fixture.ts";
import { startReplay } from "../testing/replay.ts";
import { createOpenAiProvider, type AiProvider } from "./openai.ts";
import { ExtractResult, ScopeClaims, ScopeVerdicts } from "./schemas.ts";

const SAMPLES = join(FIXTURES_DIR, "samples/evidence");

/** Fixture names (`openai/<area>/<name>`) in one area. */
function names(area: string): string[] {
  return readdirSync(join(FIXTURES_DIR, "openai", area))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `openai/${area}/${f.slice(0, -5)}`);
}

function generate<S extends z.ZodType>(provider: AiProvider, schema: S, model: string) {
  return provider.generate({
    model,
    schemaName: "replay",
    schema,
    instructions: "replay",
    task: "replay",
    evidence: [],
    maxOutputTokens: 1,
  });
}

/** Serves exactly one fixture; the provider is built after msw is listening. */
async function replay<S extends z.ZodType>(name: string, schema: S, model = "gpt-6.1-terra") {
  const r = startReplay([name]);
  try {
    const res = await generate(createOpenAiProvider({ apiKey: "replay" }), schema, model);
    expect(r.unused(), name).toEqual([]);
    return res;
  } finally {
    r.close();
  }
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
    const fixtures = names(area);
    it(`${area}: ${String(fixtures.length)} fixtures`, async () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(5);
      for (const name of fixtures) {
        const res = await replay(name, schema, model);
        expect(res.ok, name).toBe(true);
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
    for (const name of names("scope-pass2")) {
      const run = (name.split("/").at(-1) ?? "").split("-")[0] ?? "";
      const evidence = EVIDENCE[run];
      const res = await replay(name, ScopeVerdicts);
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
    expect(all).toEqual(VERBATIM_TOTALS);
  });
});

/** Pinned from the recording run (docs/evidence/m0-07-openai-spike.md §4). */
const VERBATIM_TOTALS = { verified: 39, total: 50 };

describe("openai replay: error cases", () => {
  it("a client timeout (recorded: no response) surfaces as 'timeout', never a verdict", async () => {
    const fixture = loadFixture("openai/errors/err-timeout-client");
    expect(fixture.response.status).toBe(0);
    // No response to serve: reproduce the shared client's timeout with a fetch that never answers.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const http = createHttpClient({ vendor: "openai", timeoutMs: 5, fetch: hang });
    const res = await generate(createOpenAiProvider({ apiKey: "replay", http }), ExtractResult, "gpt-6-luna");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("timeout");
  });

  it("a response cut at max_output_tokens is 'incomplete' and still costs money", async () => {
    const res = await replay("openai/errors/err-incomplete-max-output-tokens", ExtractResult, "gpt-6-luna");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ kind: "incomplete", detail: "max_output_tokens" });
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("an unknown model is an http error carrying the 404", async () => {
    const res = await replay("openai/errors/err-model-not-found", ExtractResult);
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error).toMatchObject({ kind: "http", detail: expect.stringMatching(/^404/) as string });
  });
});

describe("openai fixtures are scrubbed", () => {
  it("carry no credential headers or key-shaped text, and parse as M0-04 fixtures", () => {
    for (const area of ["extract", "scope-pass1", "scope-pass2", "errors"]) {
      for (const name of names(area)) {
        const fixture = loadFixture(name);
        expect(JSON.stringify(fixture), name).not.toMatch(
          /authorization|openai-organization|openai-project|sk-[A-Za-z0-9_-]{20,}/i,
        );
        expect(fixture.meta, name).toMatchObject({ env: "live", ticket: "M0-07", scrubbed: true });
      }
    }
  });
});
