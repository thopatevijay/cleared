// Test support: a fake OpenAI Responses endpoint (msw) that answers by the request's schema name, so the
// recorder's live path can write recordings to a temp dir with no network and no spend.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { GoldItem } from "../src/gold/schema.ts";

export const EMPTY_FACTS = {
  parties: [],
  amounts: [],
  dates: [],
  deliverables: [],
  delivery_events: [],
  shipment: null,
  instruction_like_lines: [],
};

export function responseBody(model: string, output: unknown): Record<string, unknown> {
  return {
    id: "resp_eval_test",
    object: "response",
    created_at: 1793414700,
    status: "completed",
    error: null,
    incomplete_details: null,
    model,
    output: [
      {
        id: "msg_eval_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", annotations: [], text: JSON.stringify(output) }],
      },
    ],
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1200,
    },
  };
}

/** Pass 1 = the gold lines; pass 2 = each line `met`, citing the first gold span (or `unverifiable`). */
export function scopeAnswers(item: GoldItem): Record<string, unknown> {
  const scope = item.documents.findIndex((d) => d.kind === "scope");
  const claims = item.hypotheses.map((h, i) => ({
    claim_id: `C${String(i + 1)}`,
    requirement: h.text,
    source_evidence_id: `E${String(scope + 1)}`,
    source_quote: h.text,
  }));
  const verdicts = item.hypotheses.map((h, i) => {
    const span = h.spans[0];
    const ref = span ? `E${String(item.documents.findIndex((d) => d.doc_id === span.doc_id) + 1)}` : "E1";
    return {
      claim_id: `C${String(i + 1)}`,
      verdict: span ? "met" : "unverifiable",
      rationale: "test",
      citations: span ? [{ evidence_id: ref, quote: span.quote }] : [],
    };
  });
  return { facts_v1: EMPTY_FACTS, scope_lines_v1: { claims }, scope_verdicts_v1: { verdicts } };
}

/** Starts msw with a fake /v1/responses; returns the request count and a stop function. */
export function fakeOpenAi(answers: Record<string, unknown>): { requests: () => number; close: () => void } {
  let n = 0;
  const server = setupServer(
    http.post("https://api.openai.com/v1/responses", async ({ request }) => {
      n += 1;
      const body = (await request.json()) as { model: string; text?: { format?: { name?: string } } };
      const name = body.text?.format?.name ?? "";
      if (!(name in answers)) return HttpResponse.json({ error: { message: `no answer for ${name}` } }, { status: 400 });
      return HttpResponse.json(responseBody(body.model, answers[name]));
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
  return { requests: () => n, close: () => { server.close(); } };
}

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "cleared-eval-"));
