// LIVE (claims OPENAI; skipped without OPENAI_API_KEY). One real call through the M2-02 adapter on a
// synthetic sample, compared with the M0-07 measurement of the same request (the `extract` step on
// `brief-logo.txt`, recorded 4 times: r1, r4, r5, c1), plus one rejected request ($0: OpenAI bills
// no tokens for a 400). RECORD_FIXTURES=1 writes both exchanges to fixtures/openai/m2-02/.
// Run: node --env-file=<path to .env> node_modules/vitest/vitest.mjs run src/ai/openai-provider.live.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardInput } from "@cleared/core";
import { describe, expect, it } from "vitest";
import { createHttpClient, type Exchange } from "../http/client.ts";
import { FIXTURES_DIR, loadFixture } from "../testing/fixture.ts";
import { createRecorder } from "../testing/record.ts";
import { createScrubber } from "../testing/scrub.ts";
import { OPENAI_TIMEOUT_MS } from "./openai.ts";
import { createOpenAiCompletionProvider } from "./openai-provider.ts";
import { costUsd } from "./pricing.ts";
import { ExtractResult } from "./schemas.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const RECORD = process.env["RECORD_FIXTURES"] === "1";
const MODEL = "gpt-6-luna";
const M0_07_RUNS = ["r1", "r4", "r5", "c1"];

interface RecordedUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** The M0-07 measurement of this request: median input tokens and median cost over its 4 recordings. */
export function m007Measurement(): { inputTokens: number; costUsd: number; instructions: string } {
  const fixtures = M0_07_RUNS.map((r) => loadFixture(`openai/extract/${r}-E1`));
  const usages = fixtures.map((f) => (f.response.body as { usage: RecordedUsage }).usage);
  const costs = usages.map((u) =>
    costUsd(MODEL, {
      inputTokens: u.input_tokens,
      cachedInputTokens: u.input_tokens_details.cached_tokens,
      outputTokens: u.output_tokens,
      reasoningTokens: u.output_tokens_details.reasoning_tokens,
    }),
  );
  const body = fixtures[0]?.request.body;
  const req = (typeof body === "string" ? JSON.parse(body) : body) as { instructions: string };
  return {
    inputTokens: median(usages.map((u) => u.input_tokens)),
    costUsd: median(costs),
    instructions: req.instructions,
  };
}

function setup() {
  const recorder = createRecorder({
    dir: join(FIXTURES_DIR, "openai"),
    ticket: "M2-02",
    scrubber: createScrubber({ secrets: () => [KEY] }),
    env: "live",
  });
  const onExchange = (ex: Exchange) => {
    if (RECORD) recorder.onExchange(ex);
  };
  const http = createHttpClient({
    vendor: "openai",
    timeoutMs: OPENAI_TIMEOUT_MS,
    onExchange,
    breaker: { threshold: 1 },
  });
  return { recorder, http, provider: createOpenAiCompletionProvider({ apiKey: KEY, http }) };
}

describe.skipIf(KEY === "")("openai provider LIVE (M2-02, OPENAI budget $0.50)", () => {
  it("one real call records tokens and cost within 10% of the M0-07 measurement", async () => {
    const m0 = m007Measurement();
    const { recorder, provider } = setup();
    recorder.label(
      "m2-02/live-extract-E1",
      "M2-02 live proof: extract on brief-logo.txt through openai-provider.ts",
    );
    const text = readFileSync(join(FIXTURES_DIR, "samples/evidence/brief-logo.txt"), "utf8");
    const { blocks } = guardInput([{ kind: "text", id: "E1", label: "scope brief", text }]);
    const res = await provider.complete({
      model: MODEL,
      system: m0.instructions,
      task: "Extract the facts from this evidence item.",
      dataBlocks: blocks,
      schemaName: "extract_result",
      schema: ExtractResult,
      maxOutputTokens: 2_000,
      reasoningEffort: "none",
    });
    // spend log (claims discipline: computed from usage × pricing.ts at call time)
    console.log(
      JSON.stringify({ live: "M2-02", call: "extract-E1", usage: res.usage, costUsd: res.costUsd, m0 }),
    );
    expect(res.ok).toBe(true);
    expect(res.usage).not.toBeNull();
    if (!res.usage) return;
    expect(res.costUsd).toBe(costUsd(MODEL, res.usage));
    expect(Math.abs(res.usage.inputTokens - m0.inputTokens) / m0.inputTokens).toBeLessThanOrEqual(0.1);
    expect(Math.abs(res.costUsd - m0.costUsd) / m0.costUsd).toBeLessThanOrEqual(0.1);
  }, 90_000);

  it("a 400 from OpenAI is 'rejected', costs nothing and does not trip the breaker", async () => {
    const { recorder, http, provider } = setup();
    recorder.label("m2-02/err-bad-request", "M2-02: max_output_tokens below the API minimum → 400");
    const res = await provider.complete({
      model: MODEL,
      system: "Return an empty object.",
      task: "Nothing.",
      dataBlocks: [],
      schemaName: "extract_result",
      schema: ExtractResult,
      maxOutputTokens: 1,
    });
    console.log(
      JSON.stringify({
        live: "M2-02",
        call: "bad-request",
        costUsd: res.costUsd,
        error: res.ok ? null : res.error,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rejected");
    expect(res.costUsd).toBe(0);
    expect(http.breaker.state()).toBe("closed");
  }, 60_000);
});
