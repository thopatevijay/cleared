// Runs the real workflows over the gold sets (M4-02), each through `runWorkflow` with the recording provider
// bound to that run's input hash. No shortcut: the same inputs the worker builds (extract per item with ref
// E1, then check_scope over the pack with every item's facts; explain_hold through `explainHold`, which also
// applies its own limits and fallback).
import { createHash } from "node:crypto";
import { explainHold, explainHoldWorkflow } from "@cleared/adapters/ai/workflows/explain-hold";
import {
  cacheKey,
  checkScopeWorkflow,
  explainHoldInput,
  extractInputFor,
  extractWorkflow,
  holdRule,
  ruleOfHold,
  runWorkflow,
  withEvidenceIds,
  type AgentConfig,
  type AiProvider,
  type CheckedLine,
  type EvidenceKind,
  type Facts,
  type HoldFacts,
  type JsonValue,
  type RunOutcome,
  type ScopeCheckInput,
  type StoredExplanation,
  type WorkflowDef,
} from "@cleared/core";
import type { GoldDocument, GoldItem } from "./gold/schema.ts";
import { JUDGE_PROMPT, judgeWorkflow, type JudgeOutput } from "./judge.ts";
import type { Recorder } from "./recording.ts";
import { EVAL_WORKSPACE, type EvalStore } from "./store.ts";

export interface EvalDeps {
  readonly recorder: Recorder;
  readonly store: EvalStore;
  readonly config: AgentConfig;
  /** test hook: run these workflow definitions instead of the product's (AC 2: a changed prompt) */
  readonly workflows?: Partial<Workflows>;
}

export interface Workflows {
  readonly extract: typeof extractWorkflow;
  readonly checkScope: typeof checkScopeWorkflow;
}

/** One workflow run as the report sees it. */
export interface RunInfo {
  readonly task: string;
  readonly status: string;
  readonly runId: string | null;
  readonly calls: number;
  readonly costUsd: number;
  /** the live model latency summed over the run's calls (replay serves the recorded value) */
  readonly latencyMs: number;
  readonly reason: string | null;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Wraps a provider to sum the latency the provider reports (live, or the recorded live value). */
function timed(p: AiProvider): { provider: AiProvider; latency: () => number } {
  let ms = 0;
  return {
    latency: () => ms,
    provider: {
      ...(p.worstCaseUsd ? { worstCaseUsd: p.worstCaseUsd.bind(p) } : {}),
      async complete(req) {
        const res = await p.complete(req);
        ms += res.latencyMs;
        return res;
      },
    },
  };
}

function info<O>(task: string, out: RunOutcome<O>, latencyMs: number): RunInfo {
  return {
    task,
    status: out.status,
    runId: out.runId,
    calls: out.calls,
    costUsd: out.costUsd,
    latencyMs,
    reason: "reason" in out ? out.reason : null,
  };
}

/** Runs one workflow through the harness with a recording provider bound to its input hash. */
export async function runRecorded<I extends JsonValue, O>(
  deps: EvalDeps,
  def: WorkflowDef<I, O>,
  input: I,
  correlationId: string,
): Promise<{ output: O | null; run: RunInfo }> {
  const model = deps.config.models[def.model];
  const hash = cacheKey(def.prompt, def.schemaVersion, model, input);
  const t = timed(deps.recorder.forRun(def.prompt.task, hash));
  const out = await runWorkflow(def, input, {
    provider: t.provider,
    store: deps.store,
    config: deps.config,
    workspaceId: EVAL_WORKSPACE,
    correlationId,
  });
  return { output: "output" in out ? out.output : null, run: info(def.prompt.task, out, t.latency()) };
}

// ---- extraction ----------------------------------------------------------------------------------------

export interface ExtractedDoc {
  readonly doc_id: string;
  readonly facts: Facts | null;
  readonly run: RunInfo;
}

/** `extract@v1` on one document, as the worker runs it (ref E1, text content). */
export async function extractDoc(deps: EvalDeps, itemId: string, doc: GoldDocument): Promise<ExtractedDoc> {
  const input = extractInputFor({ kind: doc.kind as EvidenceKind, sha256: sha256Hex(doc.text), text: doc.text, file: null });
  if (input === null) throw new Error(`${itemId}/${doc.doc_id}: nothing to extract`);
  const def = deps.workflows?.extract ?? extractWorkflow;
  const { output, run } = await runRecorded(deps, def, input, `eval:${itemId}:${doc.doc_id}`);
  return { doc_id: doc.doc_id, facts: output, run };
}

export async function extractItem(deps: EvalDeps, item: GoldItem): Promise<ExtractedDoc[]> {
  const out: ExtractedDoc[] = [];
  for (const d of item.documents) out.push(await extractDoc(deps, item.id, d));
  return out;
}

// ---- scope ---------------------------------------------------------------------------------------------

export interface ScopeRun {
  readonly extracted: readonly ExtractedDoc[];
  readonly lines: readonly CheckedLine[] | null;
  readonly run: RunInfo;
  /** E<n> → the gold doc id, and E<n> → its text */
  readonly docOfRef: ReadonlyMap<string, string>;
  readonly textOfRef: ReadonlyMap<string, string>;
}

/** The pack input the worker's `loadPack` builds: refs E1… in document order, facts re-keyed by ref. */
export function scopeInput(docs: readonly GoldDocument[], extracted: readonly ExtractedDoc[]): ScopeCheckInput {
  const items = docs.map((d, i) => ({
    ref: `E${String(i + 1)}`,
    kind: d.kind as EvidenceKind,
    sha256: sha256Hex(d.text),
    content: { type: "text" as const, text: d.text },
  }));
  const facts = extracted.flatMap((x, i) => {
    const ref = `E${String(i + 1)}`;
    return x.facts ? [{ ref, facts: withEvidenceIds(x.facts, () => ref) }] : [];
  });
  return { items, facts };
}

export async function scopeItem(deps: EvalDeps, item: GoldItem, docs = item.documents, tag = item.id): Promise<ScopeRun> {
  const extracted: ExtractedDoc[] = [];
  for (const d of docs) extracted.push(await extractDoc(deps, tag, d));
  const input = scopeInput(docs, extracted);
  const def = deps.workflows?.checkScope ?? checkScopeWorkflow;
  const { output, run } = await runRecorded(deps, def, input, `eval:${tag}`);
  const refs = docs.map((d, i) => [`E${String(i + 1)}`, d] as const);
  return {
    extracted,
    lines: output?.lines ?? null,
    run,
    docOfRef: new Map(refs.map(([r, d]) => [r, d.doc_id])),
    textOfRef: new Map(refs.map(([r, d]) => [r, d.text])),
  };
}

// ---- holds ---------------------------------------------------------------------------------------------

/** A fixed, synthetic hold time: the explanation's slots are filled with it (never seen by the model). */
export const HOLD_OPENED_AT = "2026-10-26T11:24:00.000Z";
export const HOLD_TIME_ZONE = "Asia/Kolkata";

/**
 * The hold as the worker stores it. A rule row that applies to a capture reason is derived from the reason
 * (so a wrong derivation fails the rule check); a badged sample, and a row that applies after a seller
 * action (tracking added: `goods_delivered`; marked completed: `service_completed`), is the hold's stored
 * `estimate_source`, as M3-03 / M3-04 write it.
 */
export function holdFactsOf(item: GoldItem): HoldFacts {
  const hold = item.hold;
  if (!hold) throw new Error(`${item.id}: not a hold item`);
  const capture = item.documents.find((d) => d.kind === "paypal_capture");
  const amount = capture
    ? (JSON.parse(capture.text) as { amount?: { value?: string; currency_code?: string } }).amount
    : undefined;
  const stored = hold.sample || holdRule(hold.expected_rule_id)?.appliesTo.kind === "action";
  const base = { ruleId: stored ? hold.expected_rule_id : "", reason: hold.capture_reason };
  const rule = ruleOfHold(base);
  return {
    ...base,
    amount: { value: amount?.value ?? "0.00", currency: amount?.currency_code ?? "USD" },
    openedAt: HOLD_OPENED_AT as HoldFacts["openedAt"],
    estimatedReleaseAt: rule.estimate(HOLD_OPENED_AT as HoldFacts["openedAt"])?.at ?? null,
    timeZone: HOLD_TIME_ZONE,
  };
}

export interface HoldRun {
  readonly facts: HoldFacts;
  readonly explanation: StoredExplanation;
  /** the model's raw answer (slots unfilled), null when the standard text was used */
  readonly raw: JsonValue | null;
  readonly run: RunInfo;
  readonly judge: JudgeOutput | null;
  readonly judgeRun: RunInfo | null;
}

export const explanationText = (e: StoredExplanation): string =>
  [e.summary, e.whatPayPalIsDoing, ...e.whatYouCanDo].join("\n");

export async function holdItem(deps: EvalDeps, item: GoldItem): Promise<HoldRun> {
  const facts = holdFactsOf(item);
  const model = deps.config.models[explainHoldWorkflow.model];
  const hash = cacheKey(explainHoldWorkflow.prompt, explainHoldWorkflow.schemaVersion, model, explainHoldInput(facts, item.locale));
  const t = timed(deps.recorder.forRun(explainHoldWorkflow.prompt.task, hash));
  const res = await explainHold(
    { provider: t.provider, store: deps.store, config: deps.config, workspaceId: EVAL_WORKSPACE, correlationId: `eval:${item.id}` },
    facts,
    item.locale,
  );
  const rec = deps.store.runs.find((r) => r.id === res.runId);
  const calls = deps.store.steps.filter((s) => s.runId === res.runId && s.kind === "call").length;
  const run: RunInfo = {
    task: explainHoldWorkflow.prompt.task,
    status: res.runStatus,
    runId: res.runId,
    calls,
    costUsd: rec?.costUsd ?? 0,
    latencyMs: t.latency(),
    reason: res.fallbackReason,
  };
  const raw = res.explanation.origin === "ai" ? (rec?.finish?.output ?? null) : null;
  const statements = item.hypotheses.map((h, i) => ({ id: `S${String(i + 1)}`, text: h.text }));
  const judged = await runRecorded(deps, judgeWorkflow, { explanation: explanationText(res.explanation), statements }, `eval:${item.id}:judge`);
  return { facts, explanation: res.explanation, raw, run, judge: judged.output, judgeRun: judged.run };
}

export const JUDGE = { promptVersion: JUDGE_PROMPT.id, model: "large" as const };

// ---- concurrency ---------------------------------------------------------------------------------------

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order in the result. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
