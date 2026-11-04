// Trajectory cases (M4-02, ≥ 6): what the workflows do step by step, through the real harness, with the
// model scripted. No network: a fetch that is ever called fails the test.
import { explainHold } from "@cleared/adapters/ai/workflows/explain-hold";
import {
  ACTION_KINDS,
  AGENT_PROPOSABLE_KINDS,
  buildDraftInput,
  checkProposal,
  checkScopeWorkflow,
  definePrompt,
  draftDisputeWorkflow,
  extractInputFor,
  extractWorkflow,
  mapReason,
  runWorkflow,
  type CompletionResult,
  type ScopeCheckInput,
  type WorkflowDef,
} from "@cleared/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { scripted } from "../src/adversarial.ts";
import { sha256Hex } from "../src/sets.ts";
import { createEvalStore, EVAL_WORKSPACE, evalConfig } from "../src/store.ts";
import { stepNames } from "../src/trajectory.ts";

const ok = (output: unknown, outputTokens = 200): CompletionResult<unknown> => ({
  ok: true,
  output,
  model: "scripted",
  usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens, reasoningTokens: 0 },
  costUsd: 0.0001,
  latencyMs: 1,
});
const fail = (kind: "timeout" | "invalid_output"): CompletionResult<unknown> => ({
  ok: false,
  error: { kind, detail: `${kind} (scripted)` },
  model: "scripted",
  usage: null,
  costUsd: 0,
  latencyMs: 1,
});

const cfg = evalConfig({}, 1);
const run = <O,>(def: WorkflowDef<never, O>, input: unknown, provider: ReturnType<typeof scripted>, store = createEvalStore(), config = cfg) =>
  ({ store, out: runWorkflow(def, input as never, { provider, store, config, workspaceId: EVAL_WORKSPACE, correlationId: "trajectory" }) });

const text = (ref: string, kind: "scope" | "delivery" | "communication", t: string) => ({ ref, kind, sha256: sha256Hex(t), content: { type: "text" as const, text: t } });
const PACK: ScopeCheckInput = {
  items: [text("E1", "scope", "Design one primary logo in SVG format."), text("E2", "delivery", "Handover: primary-logo.svg sent on 3 November.")],
  facts: [],
};
const LINES = { claims: [{ claim_id: "C1", requirement: "One primary logo", source_evidence_id: "E1", source_quote: "Design one primary logo in SVG format." }] };
const met = (quote: string) => ({ verdicts: [{ claim_id: "C1", verdict: "met", rationale: "sent", citations: [{ evidence_id: "E2", quote }] }] });

let fetches = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetches = 0;
  globalThis.fetch = (() => {
    fetches += 1;
    return Promise.reject(new Error("no network in trajectory tests"));
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetches).toBe(0);
});

describe("trajectory", () => {
  it("check_scope runs pass 1 → pass 2 → the verbatim check (a forged quote is dropped after pass 2)", async () => {
    const { store, out } = run(checkScopeWorkflow, PACK, scripted([ok(LINES), ok(met("primary-logo.svg was approved by the buyer"))]));
    const res = await out;
    expect(stepNames(store, res.runId)).toEqual(["pass1", "pass2"]);
    if (!("output" in res)) throw new Error(res.reason);
    expect(res.output.lines[0]).toMatchObject({ model_verdict: "met", verdict: "unverifiable", note: "no_valid_citation" });
    expect(res.output.lines[0]?.dropped.map((d) => d.reason)).toEqual(["not_found"]);
  });

  it("stops at 6 model calls per run", async () => {
    const loop: WorkflowDef<{ n: number }, { answer: string }> = {
      prompt: definePrompt("trajectory_loop@v1", "Answer."),
      schemaVersion: "1",
      model: "small",
      outputSchema: z.object({ answer: z.string() }),
      async run(ctx, input) {
        let last = { answer: "" };
        for (let i = 0; i < input.n; i++)
          last = await ctx.call({ name: `step${String(i)}`, task: "Answer.", evidence: [], schemaName: "a", schema: z.object({ answer: z.string() }), maxOutputTokens: 100 });
        return last;
      },
    };
    const provider = scripted([ok({ answer: "x" })]);
    const { out } = run(loop, { n: 9 }, provider);
    const res = await out;
    expect(res.status).toBe("limit_calls");
    expect(provider.requests).toBe(6);
  });

  it("clamps a step's output tokens to the per-step cap and stops at the wall clock", async () => {
    const seen: number[] = [];
    const slow = {
      worstCaseUsd: () => 0,
      complete(req: { maxOutputTokens: number }) {
        seen.push(req.maxOutputTokens);
        return new Promise<CompletionResult<never>>((resolve) => setTimeout(() => { resolve(ok(LINES) as CompletionResult<never>); }, 200));
      },
    };
    const store = createEvalStore();
    const res = await runWorkflow(checkScopeWorkflow, PACK, {
      provider: slow as never,
      store,
      config: { ...cfg, limits: { ...cfg.limits, maxOutputTokensPerStep: 1_000, wallClockMs: 50 } },
      workspaceId: EVAL_WORKSPACE,
      correlationId: "trajectory",
    });
    expect(seen).toEqual([1_000]);
    expect(res.status).toBe("limit_time");
  });

  it("a schema-invalid answer gets one retry, then the run fails closed (no output; explain_hold shows the standard text)", async () => {
    const input = extractInputFor({ kind: "communication", sha256: sha256Hex("Buyer: thanks"), text: "Buyer: thanks", file: null });
    const provider = scripted([ok({ wrong: true })]);
    const { store, out } = run(extractWorkflow, input, provider);
    const res = await out;
    expect(res.status).toBe("failed_output");
    expect(provider.requests).toBe(2);
    expect(stepNames(store, res.runId)).toEqual(["extract", "extract:repair"]);
    expect(store.runs[0]?.finish?.output).toBeNull();

    const hold = await explainHold(
      { provider: scripted([fail("invalid_output")]), store: createEvalStore(), config: cfg, workspaceId: EVAL_WORKSPACE, correlationId: "t" },
      { ruleId: "payment_review", reason: "PENDING_REVIEW", amount: { value: "64.00", currency: "USD" }, openedAt: "2026-10-26T11:24:00.000Z" as never, estimatedReleaseAt: null, timeZone: "UTC" },
      "en",
    );
    expect(hold.runStatus).toBe("failed_output");
    expect(hold.explanation.origin).toBe("standard");
  });

  it("a model timeout degrades the run: no verdict is written, nothing is retried", async () => {
    const provider = scripted([fail("timeout")]);
    const { store, out } = run(checkScopeWorkflow, PACK, provider);
    const res = await out;
    expect(res.status).toBe("degraded");
    expect(provider.requests).toBe(1);
    expect(store.runs[0]?.finish?.output).toBeNull();
  });

  it("draft_dispute proposes nothing itself, never calls PayPal, and only allowed kinds can ever be proposed", async () => {
    const built = buildDraftInput({
      dispute: {
        dispute_id: "PP-D-SYNTH-0002",
        capture_id: "SYNTH-CAPTURE-0002",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        amount: { value: "48.00", currency_code: "USD" },
        opened_at: "2026-10-29T05:16:59.065Z",
        seller_response_due_date: "2026-11-09T04:59:59.000Z",
      },
      mapping: mapReason("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", []),
      items: [{ id: "i1", kind: "shipment", createdAt: "2026-10-20T10:00:00.000Z", mime: null, text: "DHL Express JX7K4M9P2Q6R delivered" }],
      facts: [],
      lines: [],
    });
    const provider = scripted([ok({ notes: "The order was shipped and delivered.", selected_evidence_item_ids: ["E1"], fact_refs: [] })]);
    const { store, out } = run(draftDisputeWorkflow, built.input, provider);
    const res = await out;
    expect(res.status).toBe("succeeded");
    expect(stepNames(store, res.runId)).toEqual(["draft"]);
    expect(store.runs[0]?.finish?.proposals).toEqual([]);
    for (const kind of ACTION_KINDS) {
      const allowed = (AGENT_PROPOSABLE_KINDS as readonly string[]).includes(kind);
      if (!allowed) expect(checkProposal(kind, {})).toMatchObject({ ok: false, reason: "kind_not_allowed" });
    }
  });

  it("reserves each call's worst case: a run that could cross EVAL_MAX_USD never sends the request", async () => {
    const input = extractInputFor({ kind: "communication", sha256: sha256Hex("Buyer: thanks"), text: "Buyer: thanks", file: null });
    const provider = { ...scripted([ok({})]), worstCaseUsd: () => 0.02 };
    const store = createEvalStore();
    const res = await runWorkflow(extractWorkflow, input as never, { provider, store, config: evalConfig({}, 0.01), workspaceId: EVAL_WORKSPACE, correlationId: "t" });
    expect(res.status).toBe("budget_exceeded");
    expect(store.steps.map((s) => s.status)).toEqual(["budget_exceeded"]);
  });
});
