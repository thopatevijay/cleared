// M4-05 (owner decision on #49): the worst-case cost reserved against the LLM caps before each call.
import { Sha256Schema, type DataBlock } from "@cleared/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpClient } from "../http/client.ts";
import { createOpenAiCompletionProvider, inputTokensBound } from "./openai-provider.ts";
import { worstCaseCostUsd } from "./pricing.ts";

const base = {
  model: "gpt-6-luna",
  system: "sys",
  task: "task",
  schemaName: "x",
  schema: z.object({}),
  maxOutputTokens: 1_500,
};
const tags = { id: "E1", label: "E1", sha256: Sha256Schema.parse("a".repeat(64)), flagged: false };
const text = (t: string): DataBlock => ({ ...tags, kind: "text", text: t });
const pdf = (bytes: number): DataBlock => ({
  ...tags,
  kind: "pdf",
  filename: "a.pdf",
  base64: "A".repeat(Math.ceil((bytes * 4) / 3)),
});

describe("worst-case reservation (M4-05)", () => {
  it("text counts UTF-8 bytes (a token is at least one byte): Hindi counts 3 per character", () => {
    const en = inputTokensBound({ ...base, dataBlocks: [text("a".repeat(1000))] });
    const hi = inputTokensBound({ ...base, dataBlocks: [text("क".repeat(1000))] });
    expect(hi - en).toBe(2000);
  });

  it("a PDF is bounded per page and at most 30 pages", () => {
    const small = inputTokensBound({ ...base, dataBlocks: [pdf(40_000)] });
    const big = inputTokensBound({ ...base, dataBlocks: [pdf(1_500_000)] });
    expect(big).toBeGreaterThan(small);
    expect(inputTokensBound({ ...base, dataBlocks: [pdf(9_000_000)] })).toBe(big);
  });

  it("the provider reserves output at max_output_tokens × the output price, plus the input bound", () => {
    const p = createOpenAiCompletionProvider({ apiKey: "x", http: createHttpClient({ vendor: "openai" }) });
    const req = { ...base, dataBlocks: [text("hello")] };
    expect(p.worstCaseUsd?.(req)).toBe(worstCaseCostUsd("gpt-6-luna", inputTokensBound(req), 1_500));
    expect(worstCaseCostUsd("gpt-6-luna", 0, 1_500)).toBeCloseTo((1_500 * 0.5) / 1_000_000, 12);
    expect(() => worstCaseCostUsd("unknown-model", 0, 1)).toThrow(/no price/);
  });
});
