// The eval report (M4-02): `docs/evidence/eval-report.json` (validated by `EvalReportSchema`) and `.md`,
// plus the README "Measured results" block between <!-- eval:start --> and <!-- eval:end -->. Every
// number in that block is generated from the report, never typed; `eval:check-readme` fails when the block
// differs from what the committed report renders to.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const REPORT_JSON = `${REPO_ROOT}docs/evidence/eval-report.json`;
export const REPORT_MD = `${REPO_ROOT}docs/evidence/eval-report.md`;
export const README = `${REPO_ROOT}README.md`;
export const README_START = "<!-- eval:start -->";
export const README_END = "<!-- eval:end -->";

/** Pass thresholds per workflow, fixed before the first run. */
export const THRESHOLDS = { scope: 0.9, extraction: 0.9, explanations: 0.95, verbatim: 1, adversarial: 1 } as const;

export const CLAIMS_WORDING =
  "gold set labelled by Claude (independent of the OpenAI models under test), cross-checked by a second model";
/** Cohen's kappa, labeller vs second model, test split (packages/evals/gold/README.md, M4-01). */
export const KAPPA = { extraction: 0.843, scope: 0.834, holds: 0.626 } as const;

const RateSchema = z.object({
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1),
  ci95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
});
export type RateJson = z.infer<typeof RateSchema>;

const LabelStatsSchema = z.object({
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  support: z.number().int().nonnegative(),
});

const LatencySchema = z.object({ p50_ms: z.number().nonnegative(), p95_ms: z.number().nonnegative(), runs: z.number().int().nonnegative() });

const CommonSet = {
  items: z.number().int().nonnegative(),
  hypotheses: z.number().int().nonnegative(),
  accuracy: RateSchema,
  per_label: z.record(z.string(), LabelStatsSchema),
  macro_f1: z.number().min(0).max(1),
  cost_per_pack_usd: z.number().nonnegative(),
  latency: z.record(z.string(), LatencySchema),
  failed_runs: z.number().int().nonnegative(),
  threshold: z.number(),
  pass: z.boolean(),
};

export const EvalReportSchema = z.object({
  schema: z.literal("eval-report@v1"),
  generated_at: z.string(),
  commit: z.string(),
  mode: z.enum(["replay", "live"]),
  split: z.enum(["test", "dev", "all"]),
  claims: z.object({ wording: z.string(), kappa: z.record(z.string(), z.number()) }),
  models: z.object({ small: z.string(), large: z.string(), judge: z.string() }),
  prompt_versions: z.array(z.string()),
  live_run: z
    .object({
      date: z.string(),
      spend_usd: z.number().nonnegative(),
      cap_usd: z.number().positive(),
      calls: z.number().int().nonnegative(),
      command: z.string(),
    })
    .nullable(),
  sets: z.object({
    extraction: z.object({ ...CommonSet }).nullable(),
    scope: z
      .object({
        ...CommonSet,
        span_iou: RateSchema,
        verbatim: RateSchema,
        uncited_supported: z.number().int().nonnegative(),
        visual_citations: z.number().int().nonnegative(),
        dropped_quotes: z.number().int().nonnegative(),
        unmatched_lines: z.number().int().nonnegative(),
      })
      .nullable(),
    holds: z
      .object({
        ...CommonSet,
        fact_accuracy: RateSchema,
        rule_ok: RateSchema,
        language_ok: RateSchema,
        forbidden_claims: z.number().int().nonnegative(),
        fallbacks: z.number().int().nonnegative(),
        pair_parity: RateSchema,
        judge_cost_usd: z.number().nonnegative(),
      })
      .nullable(),
  }),
  adversarial: z
    .object({
      cases: z.array(z.object({ id: z.string(), category: z.string(), kind: z.enum(["recorded", "scripted"]), pass: z.boolean(), detail: z.string() })),
      passed: RateSchema,
      pass: z.boolean(),
    })
    .nullable(),
  trajectory: z.object({
    runs: z.number().int().nonnegative(),
    max_calls_per_run: z.number().int().nonnegative(),
    max_output_tokens_step: z.number().int().nonnegative(),
    max_run_latency_ms: z.number().nonnegative(),
    pass: z.boolean(),
  }),
  pass: z.boolean(),
});
export type EvalReport = z.infer<typeof EvalReportSchema>;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ci = (r: RateJson): string => `${pct(r.rate)} (${String(r.k)}/${String(r.n)}; 95% CI ${pct(r.ci95[0])}–${pct(r.ci95[1])})`;
const usd = (x: number): string => `$${x.toFixed(4)}`;

/** How the sets were produced and what it cost: recorded facts, not measured values. */
const DISCLOSURES = [
  "The eval judge was revised to `eval_judge@v2` after run 1's test-split results had been seen (run 1's numbers are kept in the PR record).",
  "The holds prompt `explain_hold@v2` was tuned on the dev split only (hold-07, hold-10).",
  "Holds missed the 95% bar in runs 1, 2 and 3 and are reported as a miss (owner accepted 2026-11-04). The threshold, the judge and the gold were not changed to pass it. Holds gold labels may be wrong where the rule source states the fact verbatim (hold-10 `kyc_incomplete` is labelled unverifiable); an audit would be a disclosed post-hoc correction (BL-01).",
];
const LIVE_SPEND: [string, number][] = [
  ["smoke runs x3 (holds, dev split)", 0.018],
  ["run 1 (all sets, test split)", 0.3102],
  ["run 2 (all sets, test split)", 0.2915],
  ["dev runs x2 (holds, dev split)", 0.012],
  ["worker fixtures (explain_hold@v2, 4 answers)", 0.0007],
  ["run 3 (holds only, test split, explain_hold@v2)", 0.0258],
];
const spendTotal = (): number => LIVE_SPEND.reduce((a, [, v]) => a + v, 0);
const spendLine = (): string => `Live spend across all runs: ${usd(spendTotal())} (${LIVE_SPEND.map(([k, v]) => `${k} ${usd(v)}`).join("; ")}).`;
const ok = (b: boolean): string => (b ? "met" : "**MISS**");

/** The README block: the headline numbers with n and CI. */
export function readmeBlock(r: EvalReport): string {
  const rows: string[] = [];
  const s = r.sets;
  if (s.scope) rows.push(`| Scope check (line verdicts) | ${ci(s.scope.accuracy)} | ${String(s.scope.items)} packs | ≥ 90%: ${ok(s.scope.pass)} |`);
  if (s.scope) rows.push(`| Citations verbatim | ${ci(s.scope.verbatim)} | ${String(s.scope.verbatim.n)} citations | 100%: ${ok(s.scope.verbatim.rate === 1)} |`);
  if (s.extraction) rows.push(`| Fact extraction (fields) | ${ci(s.extraction.accuracy)} | ${String(s.extraction.items)} items | ≥ 90%: ${ok(s.extraction.pass)} |`);
  if (s.holds) rows.push(`| Hold explanations (all checks) | ${ci(s.holds.accuracy)} | ${String(s.holds.items)} explanations | ≥ 95%: ${ok(s.holds.pass)} |`);
  if (r.adversarial) rows.push(`| Adversarial cases | ${ci(r.adversarial.passed)} | ${String(r.adversarial.cases.length)} cases | 100%: ${ok(r.adversarial.pass)} |`);
  const kappa = Object.entries(r.claims.kappa).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ");
  const live = `Disclosures: ${DISCLOSURES.slice(0, 3).join(" ")} ${spendLine()}`;
  return [
    README_START,
    `Measured on the \`${r.split}\` split of the synthetic gold sets: ${r.claims.wording} (kappa = ${kappa}). Models: \`${r.models.small}\` (extract, explain), \`${r.models.large}\` (scope check); explanations judged by \`${r.models.judge}\` for "fact conveyed" only. Full report: [docs/evidence/eval-report.md](docs/evidence/eval-report.md).`,
    "",
    "| What | Result | n | Target |",
    "|---|---|---|---|",
    ...rows,
    "",
    `${live} Replayed from recordings at commit \`${r.commit}\`.`,
    README_END,
  ].join("\n");
}

function setLines(name: string, x: { accuracy: RateJson; per_label: Record<string, z.infer<typeof LabelStatsSchema>>; macro_f1: number; cost_per_pack_usd: number; latency: Record<string, z.infer<typeof LatencySchema>>; failed_runs: number; items: number; hypotheses: number }): string[] {
  const labels = Object.entries(x.per_label).map(([l, v]) => `| ${l} | ${pct(v.precision)} | ${pct(v.recall)} | ${String(v.support)} |`);
  const lat = Object.entries(x.latency).map(([t, v]) => `${t} p50 ${String(Math.round(v.p50_ms))} ms / p95 ${String(Math.round(v.p95_ms))} ms (${String(v.runs)} runs)`);
  return [
    `## ${name}`,
    "",
    `- n: ${String(x.items)} items, ${String(x.hypotheses)} gold lines`,
    `- accuracy: ${ci(x.accuracy)}`,
    `- macro-F1: ${x.macro_f1.toFixed(3)}`,
    `- cost per pack: ${usd(x.cost_per_pack_usd)}; latency: ${lat.join("; ")}`,
    `- runs that produced no output: ${String(x.failed_runs)}`,
    "",
    "| label | precision | recall | support |",
    "|---|---|---|---|",
    ...labels,
    "",
  ];
}

export function reportMarkdown(r: EvalReport): string {
  const out = [
    "# Eval report",
    "",
    `Generated ${r.generated_at} at commit \`${r.commit}\` (${r.mode}, split \`${r.split}\`). Generated by \`pnpm eval:report\`; do not edit by hand.`,
    "",
    `Gold sets: ${r.claims.wording} (kappa = ${Object.entries(r.claims.kappa).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ")}). All personal data is synthetic. See packages/evals/gold/README.md.`,
    "",
    `Models: small \`${r.models.small}\`, large \`${r.models.large}\`, judge \`${r.models.judge}\`. Prompts: ${r.prompt_versions.map((p) => `\`${p}\``).join(", ")}.`,
    "",
    r.live_run
      ? `Last live run: ${r.live_run.date}, \`${r.live_run.command}\`, spend ${usd(r.live_run.spend_usd)} of a ${usd(r.live_run.cap_usd)} cap (\`EVAL_MAX_USD\`), ${String(r.live_run.calls)} model calls, from the API responses' usage.`
      : "Last live run: none recorded.",
    "",
    spendLine(),
    "",
    "## Disclosures",
    "",
    ...DISCLOSURES.map((d) => `- ${d}`),
    "",
    `**Overall: ${r.pass ? "every threshold met" : "a threshold was missed"}.**`,
    "",
  ];
  const s = r.sets;
  if (s.scope)
    out.push(
      ...setLines("Scope check (`check_scope@v1`)", s.scope),
      `- span overlap with gold (token IoU ≥ 0.5): ${ci(s.scope.span_iou)}`,
      `- stored citations verbatim: ${ci(s.scope.verbatim)}; met/partial lines without a citation: ${String(s.scope.uncited_supported)}`,
      `- visual citations (screenshot-only support, not verbatim-checked): ${String(s.scope.visual_citations)}; model quotes dropped by the verbatim check: ${String(s.scope.dropped_quotes)}; gold lines with no matching model line: ${String(s.scope.unmatched_lines)}`,
      "",
    );
  if (s.extraction) out.push(...setLines("Extraction (`extract@v1`)", s.extraction));
  if (s.holds)
    out.push(
      ...setLines(`Hold explanations (\`${r.prompt_versions.find((p) => p.startsWith("explain_hold@")) ?? "explain_hold"}\`)`, s.holds),
      `- facts conveyed as labelled (judge): ${ci(s.holds.fact_accuracy)}`,
      `- correct rule row: ${ci(s.holds.rule_ok)}; language = locale: ${ci(s.holds.language_ok)}; forbidden claims: ${String(s.holds.forbidden_claims)}; standard-text fallbacks: ${String(s.holds.fallbacks)}`,
      `- EN/HI fact parity (same fact codes conveyed in both languages): ${ci(s.holds.pair_parity)}`,
      `- judge cost (not product cost): ${usd(s.holds.judge_cost_usd)}`,
      "",
    );
  if (r.adversarial)
    out.push(
      "## Adversarial cases",
      "",
      `${ci(r.adversarial.passed)} passed.`,
      "",
      "| case | kind | result | detail |",
      "|---|---|---|---|",
      ...r.adversarial.cases.map((c) => `| ${c.id} | ${c.kind} | ${c.pass ? "pass" : "**fail**"} | ${c.detail.replace(/\|/g, "\\|")} |`),
      "",
    );
  const t = r.trajectory;
  out.push(
    "## Trajectory (every run in this eval)",
    "",
    `${String(t.runs)} runs; most model calls in one run ${String(t.max_calls_per_run)} (cap 6); largest output per step ${String(t.max_output_tokens_step)} tokens (cap 4000); slowest run ${String(Math.round(t.max_run_latency_ms))} ms of model time (cap 120000): ${t.pass ? "within caps" : "**a cap was exceeded**"}.`,
    "",
  );
  return out.join("\n");
}

export function writeReport(r: EvalReport, jsonPath = REPORT_JSON, mdPath = REPORT_MD): void {
  EvalReportSchema.parse(r);
  writeFileSync(jsonPath, `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(mdPath, `${reportMarkdown(r)}\n`);
}

/** Replaces the block between the markers (adding the markers under "## Measured results" the first time). */
export function withReadmeBlock(readme: string, block: string): string {
  const s = readme.indexOf(README_START);
  const e = readme.indexOf(README_END);
  if (s >= 0 && e > s) return readme.slice(0, s) + block + readme.slice(e + README_END.length);
  const heading = "## Measured results\n";
  const h = readme.indexOf(heading);
  if (h < 0) throw new Error("README: no '## Measured results' section");
  const after = readme.indexOf("\n## ", h + heading.length);
  const end = after < 0 ? readme.length : after + 1;
  return `${readme.slice(0, h + heading.length)}\n${block}\n\n${readme.slice(end)}`;
}

export function readReport(path = REPORT_JSON): EvalReport {
  if (!existsSync(path)) throw new Error(`no report at ${path}: run pnpm eval:report`);
  return EvalReportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** CI check: the README block equals what the committed report renders to. */
export function checkReadme(readme: string, report: EvalReport): string | null {
  const s = readme.indexOf(README_START);
  const e = readme.indexOf(README_END);
  if (s < 0 || e < s) return "README has no eval block (<!-- eval:start --> … <!-- eval:end -->)";
  const current = readme.slice(s, e + README_END.length);
  return current === readmeBlock(report) ? null : "README eval block differs from docs/evidence/eval-report.json: run pnpm eval:report";
}
