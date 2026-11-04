// The whole runner path (record → answer from the recording → score → report) on the dev split, against a
// fake OpenAI endpoint (msw) in a temp dir: no network, no key, no spend. Then the same run replays offline
// from those recordings and gives the same report numbers.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe, expect, it } from "vitest";
import { evaluate, type EvaluateOptions } from "../src/evaluate.ts";
import { createRecorder } from "../src/recording.ts";
import { EvalReportSchema } from "../src/report.ts";
import { createEvalStore, evalConfig } from "../src/store.ts";
import { EMPTY_FACTS, responseBody, tempDir } from "./support.ts";

/** Answers by schema name, reading what it needs from the request (ids only, never instructions). */
function answer(name: string, input: string): unknown {
  switch (name) {
    case "facts_v1":
      return EMPTY_FACTS;
    case "scope_lines_v1":
      return { claims: [{ claim_id: "C1", requirement: "the agreed work", source_evidence_id: "E1", source_quote: "not a real quote from the scope" }] };
    case "scope_verdicts_v1":
      return { verdicts: [{ claim_id: "C1", verdict: "unverifiable", rationale: "test", citations: [] }] };
    case "hold_explanation_v1": {
      const rule = /\\"id\\":\\"([a-z0-9_]+)\\"/.exec(input)?.[1] ?? "unknown";
      return { summary: "PayPal is holding this payment for now.", whatPayPalIsDoing: "PayPal decides when the hold ends.", whatYouCanDo: [], ruleId: rule };
    }
    case "judge_v1": {
      const ids = [...new Set(input.match(/S\d{1,2}(?=\\")/g) ?? [])];
      return { verdicts: ids.map((id) => ({ id, conveyed: false, note: "absent" })) };
    }
    default:
      throw new Error(`no answer for ${name}`);
  }
}

describe("evaluate (dev split, fake endpoint)", () => {
  it("records, scores and reports; replay gives the same numbers offline", async () => {
    const dir = tempDir();
    const server = setupServer(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        const raw = await request.text();
        const body = JSON.parse(raw) as { model: string; text?: { format?: { name?: string } } };
        return HttpResponse.json(responseBody(body.model, answer(body.text?.format?.name ?? "", raw)));
      }),
    );
    const opts: EvaluateOptions = { sets: ["extraction", "scope", "holds"], split: "dev", concurrency: 4, mode: "live", log: () => undefined };
    server.listen({ onUnhandledFrame: "error" });
    let live;
    try {
      live = await evaluate({ recorder: createRecorder({ mode: "live", dir, apiKey: "sk-test-not-a-key" }), store: createEvalStore(), config: evalConfig({}, 5) }, opts);
    } finally {
      server.close();
    }
    expect(live.stale).toEqual([]);
    const r = EvalReportSchema.parse(live.report);
    expect(r.sets.extraction?.items).toBe(8);
    expect(r.sets.scope?.items).toBe(9);
    expect(r.sets.holds?.items).toBe(4);
    expect(r.sets.scope?.verbatim.rate ?? 0).toBeLessThanOrEqual(1);
    expect(r.trajectory.pass).toBe(true);
    expect(r.sets.holds?.rule_ok.k).toBe(4);
    // the fake answers in English with fixed text: both Hindi items (and any rule its text fails) fall back
    expect(r.sets.holds?.fallbacks).toBeGreaterThanOrEqual(2);

    const replay = await evaluate(
      { recorder: createRecorder({ mode: "replay", dir }), store: createEvalStore(), config: evalConfig({}, 1_000_000) },
      { ...opts, mode: "replay" },
    );
    expect(replay.stale).toEqual([]);
    expect(replay.report.sets).toEqual(live.report.sets);
  }, 60_000);
});
