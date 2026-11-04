// One eval run (M4-02): the gold items through the real workflows, scored, and turned into the report.
// Used by `pnpm eval` (runner.ts) and `pnpm eval:report`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { explainHoldWorkflow } from "@cleared/adapters/ai/workflows/explain-hold";
import {
  CHECK_SCOPE_PROMPT,
  EXTRACT_PROMPT,
  explainHoldInput,
  explainHoldProblems,
  ExplainHoldOutputSchema,
} from "@cleared/core";
import { runAdversarial, type CaseResult } from "./adversarial.ts";
import { goldFile, readJsonl } from "./gold/io.ts";
import { GoldItemSchema, type GoldItem, type GoldSet } from "./gold/schema.ts";
import { JUDGE_PROMPT } from "./judge.ts";
import { EVAL_FIXTURE_DIR, type Recorder } from "./recording.ts";
import { CLAIMS_WORDING, KAPPA, THRESHOLDS, type EvalReport, type RateJson } from "./report.ts";
import {
  auditCitations,
  factParity,
  percentile,
  perLabel,
  scoreExtraction,
  scoreHold,
  scoreScope,
  wilson,
  type HoldScore,
  type Predicted,
} from "./score.ts";
import { extractItem, explanationText, holdItem, pool, scopeItem, type EvalDeps, type RunInfo, type ScopeRun } from "./sets.ts";
import { trajectorySummary } from "./trajectory.ts";
import type { Label } from "./gold/schema.ts";

export const EVAL_SETS = ["extraction", "scope", "holds", "adversarial"] as const;
export type EvalSet = (typeof EVAL_SETS)[number];
export type Split = "test" | "dev" | "all";
export const RUN_FILE = join(EVAL_FIXTURE_DIR, "RUN.json");

export interface EvaluateOptions {
  readonly sets: readonly EvalSet[];
  readonly split: Split;
  readonly concurrency: number;
  readonly mode: "replay" | "live";
  readonly log: (line: string) => void;
}

export function loadItems(set: GoldSet, split: Split): GoldItem[] {
  return readJsonl(goldFile(set), GoldItemSchema).filter((i) => split === "all" || i.split === split);
}

const rate = (k: number, n: number): RateJson => {
  const w = wilson(k, n);
  return { k: w.k, n: w.n, rate: w.rate, ci95: [w.ci95[0], w.ci95[1]] };
};

type Latency = Record<string, { p50_ms: number; p95_ms: number; runs: number }>;

function latency(runs: readonly RunInfo[]): Latency {
  const out: Latency = {};
  for (const task of [...new Set(runs.map((r) => r.task))].sort()) {
    const ms = runs.filter((r) => r.task === task && r.calls > 0).map((r) => r.latencyMs);
    out[task] = { p50_ms: percentile(ms, 50), p95_ms: percentile(ms, 95), runs: ms.length };
  }
  return out;
}

const failed = (runs: readonly RunInfo[]): number => runs.filter((r) => r.status !== "succeeded" && r.status !== "cache_hit").length;
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

async function evalExtraction(deps: EvalDeps, items: readonly GoldItem[], c: number): Promise<EvalReport["sets"]["extraction"]> {
  const done = await pool(items, c, async (item) => ({ item, docs: await extractItem(deps, item) }));
  const scored = done.flatMap(({ item, docs }) => scoreExtraction(item, docs.flatMap((d) => (d.facts ? [d.facts] : []))));
  const runs = done.flatMap((d) => d.docs.map((x) => x.run));
  const bin = (l: Label): Label => (l === "met" || l === "partial" ? "met" : "missing");
  const pl = perLabel(scored.map((s) => [bin(s.label), s.found ? "met" : "missing"] as const));
  const acc = rate(scored.filter((s) => s.correct).length, scored.length);
  return {
    items: items.length,
    hypotheses: scored.length,
    accuracy: acc,
    per_label: pl.labels,
    macro_f1: pl.macroF1,
    cost_per_pack_usd: mean(done.map((d) => d.docs.reduce((a, x) => a + x.run.costUsd, 0))),
    latency: latency(runs),
    failed_runs: failed(runs),
    threshold: THRESHOLDS.extraction,
    pass: acc.rate >= THRESHOLDS.extraction && failed(runs) === 0,
  };
}

async function evalScope(deps: EvalDeps, items: readonly GoldItem[], c: number, keep: Map<string, ScopeRun>): Promise<EvalReport["sets"]["scope"]> {
  const done = await pool(items, c, async (item) => ({ item, run: await scopeItem(deps, item) }));
  for (const d of done) keep.set(d.item.id, d.run);
  const scored = done.flatMap(({ item, run }) => scoreScope(item, run.lines ?? [], run.docOfRef));
  const audits = done.map(({ run }) => auditCitations(run.lines ?? [], run.textOfRef));
  const runs = done.flatMap((d) => [...d.run.extracted.map((x) => x.run), d.run.run]);
  const pl = perLabel(scored.map((s) => [s.gold, s.predicted] as [Label, Predicted]));
  const acc = rate(scored.filter((s) => s.gold === s.predicted).length, scored.length);
  const spans = scored.filter((s) => s.spanMatch !== null);
  const sum = (f: (a: (typeof audits)[number]) => number): number => audits.reduce((x, a) => x + f(a), 0);
  const verbatim = rate(sum((a) => a.verbatim), sum((a) => a.stored));
  const uncited = sum((a) => a.uncitedSupported);
  return {
    items: items.length,
    hypotheses: scored.length,
    accuracy: acc,
    per_label: pl.labels,
    macro_f1: pl.macroF1,
    cost_per_pack_usd: mean(done.map((d) => d.run.run.costUsd + d.run.extracted.reduce((a, x) => a + x.run.costUsd, 0))),
    latency: latency(runs),
    failed_runs: failed(runs),
    threshold: THRESHOLDS.scope,
    pass: acc.rate >= THRESHOLDS.scope && verbatim.rate >= THRESHOLDS.verbatim && uncited === 0,
    span_iou: rate(spans.filter((s) => s.spanMatch).length, spans.length),
    verbatim,
    uncited_supported: uncited,
    visual_citations: sum((a) => a.visual),
    dropped_quotes: sum((a) => a.dropped),
    unmatched_lines: scored.filter((s) => s.line_id === null).length,
  };
}

async function scoreHoldRun(deps: EvalDeps, item: GoldItem): Promise<{ item: GoldItem; score: HoldScore; runs: RunInfo[]; judgeCost: number }> {
  const r = await holdItem(deps, item);
  const raw = r.raw === null ? null : ExplainHoldOutputSchema.safeParse(r.raw);
  const conveyed = new Map<string, boolean>();
  item.hypotheses.forEach((h, i) => {
    const v = r.judge?.verdicts.find((x) => x.id === `S${String(i + 1)}`);
    if (v) conveyed.set(h.h_id, v.conveyed);
  });
  const score = scoreHold({
    item,
    expectedRuleId: item.hold?.expected_rule_id ?? "",
    shownRuleId: r.explanation.ruleId,
    modelRuleId: raw?.success ? raw.data.ruleId : null,
    text: explanationText(r.explanation),
    guardrailProblems: raw?.success ? explainHoldProblems(raw.data, explainHoldInput(r.facts, item.locale)) : [],
    conveyed,
    ai: r.explanation.origin === "ai",
  });
  return { item, score, runs: [r.run, ...(r.judgeRun ? [r.judgeRun] : [])], judgeCost: r.judgeRun?.costUsd ?? 0 };
}

async function evalHolds(deps: EvalDeps, items: readonly GoldItem[], c: number): Promise<EvalReport["sets"]["holds"]> {
  const done = await pool(items, c, (item) => scoreHoldRun(deps, item));
  const facts = done.flatMap((d) => d.score.facts);
  const explainRuns = done.map((d) => d.runs[0]).filter((r): r is RunInfo => r !== undefined);
  const pl = perLabel(facts.map((f) => [f.label === "met" || f.label === "partial" ? "met" : "missing", f.conveyed === true ? "met" : "missing"] as [Label, Predicted]));
  const pairs = [...new Set(done.map((d) => d.item.hold?.pair_id ?? ""))].flatMap((p) => {
    const en = done.find((d) => d.item.hold?.pair_id === p && d.item.locale === "en");
    const hi = done.find((d) => d.item.hold?.pair_id === p && d.item.locale === "hi");
    return en && hi ? [factParity(en.score, hi.score)] : [];
  });
  const acc = rate(done.filter((d) => d.score.pass).length, done.length);
  return {
    items: items.length,
    hypotheses: facts.length,
    accuracy: acc,
    per_label: pl.labels,
    macro_f1: pl.macroF1,
    cost_per_pack_usd: mean(explainRuns.map((r) => r.costUsd)),
    latency: latency(done.flatMap((d) => d.runs)),
    failed_runs: failed(explainRuns),
    threshold: THRESHOLDS.explanations,
    pass: acc.rate >= THRESHOLDS.explanations,
    fact_accuracy: rate(facts.filter((f) => f.correct).length, facts.length),
    rule_ok: rate(done.filter((d) => d.score.ruleOk).length, done.length),
    language_ok: rate(done.filter((d) => d.score.languageOk).length, done.length),
    forbidden_claims: done.reduce((a, d) => a + d.score.forbidden.length, 0),
    fallbacks: done.filter((d) => !d.score.ai).length,
    pair_parity: rate(pairs.filter(Boolean).length, pairs.length),
    judge_cost_usd: done.reduce((a, d) => a + d.judgeCost, 0),
  };
}


export interface LiveRun {
  readonly date: string;
  readonly spend_usd: number;
  readonly cap_usd: number;
  readonly calls: number;
  readonly command: string;
}

export function readLiveRun(): LiveRun | null {
  if (!existsSync(RUN_FILE)) return null;
  return JSON.parse(readFileSync(RUN_FILE, "utf8")) as LiveRun;
}

export function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export interface Evaluation {
  readonly report: EvalReport;
  readonly stale: Recorder["stale"];
}

export async function evaluate(deps: EvalDeps, o: EvaluateOptions): Promise<Evaluation> {
  const has = (s: EvalSet): boolean => o.sets.includes(s);
  const keep = new Map<string, ScopeRun>();
  const c = o.concurrency;
  const extraction = has("extraction") ? await evalExtraction(deps, loadItems("extraction", o.split), c) : null;
  o.log(extraction ? `extraction: n=${String(extraction.items)} items, ${String(extraction.hypotheses)} facts` : "extraction: skipped");
  const scope = has("scope") ? await evalScope(deps, loadItems("scope", o.split), c, keep) : null;
  o.log(scope ? `scope: n=${String(scope.items)} packs, ${String(scope.hypotheses)} lines` : "scope: skipped");
  const holds = has("holds") ? await evalHolds(deps, loadItems("holds", o.split), c) : null;
  o.log(holds ? `holds: n=${String(holds.items)} explanations, ${String(holds.hypotheses)} facts` : "holds: skipped");
  let adversarial: EvalReport["adversarial"] = null;
  if (has("adversarial")) {
    const cases: CaseResult[] = await runAdversarial(deps, loadItems("scope", "all"), keep);
    const passed = rate(cases.filter((x) => x.pass).length, cases.length);
    adversarial = { cases, passed, pass: passed.rate >= THRESHOLDS.adversarial };
    o.log(`adversarial: n=${String(cases.length)} cases`);
  }
  const traj = trajectorySummary(deps.store, deps.config);
  const live = readLiveRun();
  const report: EvalReport = {
    schema: "eval-report@v1",
    generated_at: new Date().toISOString(),
    commit: gitCommit(),
    mode: o.mode,
    split: o.split,
    claims: { wording: CLAIMS_WORDING, kappa: { ...KAPPA } },
    models: { small: deps.config.models.small, large: deps.config.models.large, judge: deps.config.models.large },
    prompt_versions: [EXTRACT_PROMPT.id, CHECK_SCOPE_PROMPT.id, explainHoldWorkflow.prompt.id, JUDGE_PROMPT.id],
    live_run: live,
    sets: { extraction, scope, holds },
    adversarial,
    trajectory: traj,
    pass: [extraction, scope, holds, adversarial].every((x) => x === null || x.pass) && traj.pass,
  };
  return { report, stale: deps.recorder.stale };
}
