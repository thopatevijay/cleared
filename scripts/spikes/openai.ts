// M0-07 OpenAI spike: per pack extract (SMALL) -> check_scope pass 1 (LARGE) -> pass 2 (LARGE) ->
// verbatim check; then the error cases. Measures tokens, cost and latency; --record writes scrubbed
// fixtures to fixtures/openai/{extract,scope-pass1,scope-pass2,errors}/ (M0-04 format).
//
//   node --env-file=<path to .env> scripts/spikes/openai.ts --record
//
// Spend guard: every call reserves its worst case (input estimate + max_output_tokens) against
// MAX_USD, accumulated across runs in .prp/m0-07-spend.json (gitignored); a call that could cross
// the cap is not made.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenAiProvider,
  type AiResult,
  type EvidencePart,
} from "../../packages/adapters/src/ai/openai.ts";
import { recordingFetch, type Exchange, type Fixture } from "../../packages/adapters/src/ai/exchange.ts";
import { priceFor } from "../../packages/adapters/src/ai/prices.ts";
import { ExtractResult, ScopeClaims, ScopeVerdicts } from "../../packages/adapters/src/ai/schemas.ts";
import { checkQuotes, type QuoteCheck } from "../../packages/core/src/proof/verbatim.ts";
import { EXTRACT_INSTRUCTIONS, PASS1_INSTRUCTIONS, PASS2_INSTRUCTIONS, pass2Task } from "./openai-prompts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLES = join(ROOT, "fixtures/samples/evidence");
const FIXTURES = join(ROOT, "fixtures/openai");
const LEDGER = join(ROOT, ".prp/m0-07-spend.json");
const REPORT = join(ROOT, "docs/evidence/m0-07-openai-spike.json");
const MAX_USD = 0.5;
const RECORD = process.argv.includes("--record");
const SMALL = process.env.OPENAI_MODEL_SMALL || "gpt-6-luna";
const LARGE = process.env.OPENAI_MODEL_LARGE || "gpt-6.1-terra";
const apiKey = process.env.OPENAI_API_KEY ?? "";
if (apiKey === "") throw new Error("OPENAI_API_KEY is not set (load .env with node --env-file)");

interface Item {
  id: string;
  file: string;
  kind: EvidencePart["kind"];
  label: string;
}
interface Pack {
  run: string;
  name: string;
  items: Item[];
  note: string;
}

const logo = (chat: string): Item[] => [
  { id: "E1", file: "brief-logo.txt", kind: "text", label: "scope brief" },
  { id: "E2", file: chat, kind: "text", label: "client chat export" },
  { id: "E3", file: "delivery-logo.pdf", kind: "pdf", label: "delivery: brand guide PDF" },
  { id: "E4", file: "screenshot-logo.png", kind: "image", label: "delivery: shared folder screenshot" },
];
const PACKS: Pack[] = [
  { run: "r1", name: "logo", items: logo("chat-logo.txt"), note: "distinct; chat has the injection line" },
  {
    run: "r2",
    name: "translation",
    note: "distinct",
    items: [
      { id: "E1", file: "brief-translation.txt", kind: "text", label: "scope brief" },
      { id: "E2", file: "chat-translation.txt", kind: "text", label: "client chat export" },
      { id: "E3", file: "delivery-translation.pdf", kind: "pdf", label: "delivery: translated manual PDF" },
    ],
  },
  {
    run: "r3",
    name: "website",
    note: "distinct",
    items: [
      { id: "E1", file: "brief-website.txt", kind: "text", label: "scope brief" },
      { id: "E2", file: "chat-website.txt", kind: "text", label: "client chat export" },
      { id: "E3", file: "screenshot-website.png", kind: "image", label: "delivery: website screenshot" },
    ],
  },
  { run: "r4", name: "logo", items: logo("chat-logo.txt"), note: "repeat of r1 (variance)" },
  { run: "r5", name: "logo", items: logo("chat-logo.txt"), note: "repeat of r1 (variance)" },
  {
    run: "c1",
    name: "logo-control",
    items: logo("chat-logo-control.txt"),
    note: "control: r1 without the injection line (not in n = 5)",
  },
];

// ---- spend ledger -------------------------------------------------------------------------
let spent = existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, "utf8")) as { usd: number }).usd : 0;
function reserve(model: string, inputChars: number, files: number, maxOut: number): void {
  const p = priceFor(model);
  const worst = ((inputChars / 3 + files * 3000) * p.inputPerM + maxOut * p.outputPerM) / 1e6;
  if (spent + worst > MAX_USD)
    throw new Error(
      `spend guard: $${spent.toFixed(4)} spent + $${worst.toFixed(4)} worst case > $${String(MAX_USD)}`,
    );
}
function charge(usd: number): void {
  spent += usd;
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ usd: spent }));
}

// ---- recording ------------------------------------------------------------------------------
let target: { area: string; name: string } | null = null;
function onExchange(ex: Exchange): void {
  if (!RECORD || target === null) return;
  const dir = join(FIXTURES, target.area);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${target.name}.json`);
  for (let n = 2; existsSync(path); n += 1) path = join(dir, `${target.name}-attempt${String(n)}.json`);
  const fixture: Fixture = {
    meta: { recorded_at: new Date().toISOString(), env: "live", ticket: "M0-07", scrubbed: true },
    ...ex,
  };
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
}
const fetchImpl = recordingFetch(onExchange);
const provider = createOpenAiProvider({ apiKey, fetch: fetchImpl });

// ---- evidence -------------------------------------------------------------------------------
function part(item: Item): EvidencePart {
  const path = join(SAMPLES, item.file);
  if (item.kind === "text")
    return { kind: "text", evidenceId: item.id, label: item.label, text: readFileSync(path, "utf8") };
  const base64 = readFileSync(path).toString("base64");
  if (item.kind === "pdf")
    return { kind: "pdf", evidenceId: item.id, label: item.label, filename: item.file, base64 };
  return { kind: "image", evidenceId: item.id, label: item.label, mimeType: "image/png", base64 };
}
/** The text a quote is verified against: text items as stored, PDFs by their text layer, images none. */
function evidenceText(items: Item[]): { id: string; text: string }[] {
  return items.flatMap((i) => {
    if (i.kind === "text") return [{ id: i.id, text: readFileSync(join(SAMPLES, i.file), "utf8") }];
    if (i.kind === "pdf") return [{ id: i.id, text: readFileSync(join(SAMPLES, `${i.file}.txt`), "utf8") }];
    return [];
  });
}
const chars = (parts: EvidencePart[]): number =>
  parts.reduce((n, p) => n + (p.kind === "text" ? p.text.length : 0), 0);
const fileCount = (parts: EvidencePart[]): number => parts.filter((p) => p.kind !== "text").length;

// ---- one measured call ----------------------------------------------------------------------
interface Row {
  run: string;
  step: string;
  item: string;
  model: string;
  ok: boolean;
  error: string | null;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  usd: number;
  ms: number;
}
const rows: Row[] = [];

async function call<T>(
  run: string,
  step: string,
  item: string,
  area: string,
  fn: () => Promise<AiResult<T>>,
): Promise<AiResult<T>> {
  target = { area, name: `${run}-${item}` };
  const res = await fn();
  target = null;
  charge(res.costUsd);
  const u = res.usage;
  rows.push({
    run,
    step,
    item,
    model: res.model,
    ok: res.ok,
    error: res.ok ? null : `${res.error.kind}: ${res.error.detail.slice(0, 200)}`,
    input: u?.inputTokens ?? 0,
    cached: u?.cachedInputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    reasoning: u?.reasoningTokens ?? 0,
    usd: res.costUsd,
    ms: res.latencyMs,
  });
  console.log(
    `${run} ${step} ${item} ${res.ok ? "ok" : "FAIL"} in=${String(u?.inputTokens ?? 0)} out=${String(u?.outputTokens ?? 0)} $${res.costUsd.toFixed(5)} ${String(res.latencyMs)}ms total=$${spent.toFixed(4)}`,
  );
  return res;
}

// ---- the pack pipeline ----------------------------------------------------------------------
interface PackOutcome {
  run: string;
  name: string;
  note: string;
  extract: { id: string; ok: boolean; instruction_like_lines: string[] }[];
  claims: ScopeClaims | null;
  claimQuoteChecks: QuoteCheck[];
  verdicts: ScopeVerdicts | null;
  citationChecks: QuoteCheck[];
  finalVerdicts: { claim_id: string; model: string; final: string; requirement: string }[];
}

async function runPack(pack: Pack): Promise<PackOutcome> {
  const parts = pack.items.map(part);
  const out: PackOutcome = {
    run: pack.run,
    name: pack.name,
    note: pack.note,
    extract: [],
    claims: null,
    claimQuoteChecks: [],
    verdicts: null,
    citationChecks: [],
    finalVerdicts: [],
  };
  for (const p of parts) {
    reserve(SMALL, chars([p]), fileCount([p]), 2000);
    const r = await call(pack.run, "extract", p.evidenceId, "extract", () =>
      provider.generate({
        model: SMALL,
        schemaName: "extract_result",
        schema: ExtractResult,
        instructions: EXTRACT_INSTRUCTIONS,
        task: "Extract the facts from this evidence item.",
        evidence: [p],
        maxOutputTokens: 2000,
        reasoningEffort: "none",
      }),
    );
    out.extract.push({
      id: p.evidenceId,
      ok: r.ok,
      instruction_like_lines: r.ok ? r.value.instruction_like_lines : [],
    });
  }
  const scopeParts = parts.filter((p) => p.kind === "text");
  reserve(LARGE, chars(scopeParts), 0, 3000);
  const p1 = await call(pack.run, "scope-pass1", "claims", "scope-pass1", () =>
    provider.generate({
      model: LARGE,
      schemaName: "scope_claims",
      schema: ScopeClaims,
      instructions: PASS1_INSTRUCTIONS,
      task: "List the agreed deliverables for this order.",
      evidence: scopeParts,
      maxOutputTokens: 3000,
      reasoningEffort: "low",
    }),
  );
  if (!p1.ok) return out;
  out.claims = p1.value;
  const texts = evidenceText(pack.items);
  out.claimQuoteChecks = checkQuotes(
    p1.value.claims.map((c) => ({ evidenceId: c.source_evidence_id, quote: c.source_quote })),
    texts,
  );
  const task = pass2Task(
    JSON.stringify(p1.value.claims.map(({ claim_id, requirement }) => ({ claim_id, requirement }))),
  );
  reserve(LARGE, chars(parts) + task.length, fileCount(parts), 5000);
  const p2 = await call(pack.run, "scope-pass2", "verdicts", "scope-pass2", () =>
    provider.generate({
      model: LARGE,
      schemaName: "scope_verdicts",
      schema: ScopeVerdicts,
      instructions: PASS2_INSTRUCTIONS,
      task,
      evidence: parts,
      maxOutputTokens: 5000,
      reasoningEffort: "low",
    }),
  );
  if (!p2.ok) return out;
  out.verdicts = p2.value;
  applyVerbatim(out, p1.value, p2.value, texts);
  return out;
}

/** Code, not the model, has the last word: met/partial without a verified quote becomes unverifiable. */
function applyVerbatim(
  out: PackOutcome,
  claims: ScopeClaims,
  verdicts: ScopeVerdicts,
  texts: { id: string; text: string }[],
): void {
  for (const v of verdicts.verdicts) {
    const checks = checkQuotes(
      v.citations.map((c) => ({ evidenceId: c.evidence_id, quote: c.quote })),
      texts,
    );
    out.citationChecks.push(...checks);
    const verified = checks.some((c) => c.status === "verified");
    const final = (v.verdict === "met" || v.verdict === "partial") && !verified ? "unverifiable" : v.verdict;
    const requirement = claims.claims.find((c) => c.claim_id === v.claim_id)?.requirement ?? "";
    out.finalVerdicts.push({ claim_id: v.claim_id, model: v.verdict, final, requirement });
  }
}

// ---- error cases ----------------------------------------------------------------------------
async function errorCases(): Promise<void> {
  const brief = part({ id: "E1", file: "brief-logo.txt", kind: "text", label: "scope brief" });
  const base = {
    schemaName: "extract_result",
    schema: ExtractResult,
    instructions: EXTRACT_INSTRUCTIONS,
    task: "Extract the facts from this evidence item.",
    evidence: [brief],
    reasoningEffort: "none" as const,
  };
  reserve(SMALL, chars([brief]), 0, 2000);
  const timeoutProvider = createOpenAiProvider({ apiKey, fetch: fetchImpl, timeoutMs: 1, maxRetries: 0 });
  await call("err", "error", "timeout-client", "errors", () =>
    timeoutProvider.generate({ ...base, model: SMALL, maxOutputTokens: 2000 }),
  );
  reserve(SMALL, chars([brief]), 0, 16);
  await call("err", "error", "incomplete-max-output-tokens", "errors", () =>
    provider.generate({ ...base, model: SMALL, maxOutputTokens: 16 }),
  );
  const noRetry = createOpenAiProvider({ apiKey, fetch: fetchImpl, maxRetries: 0 });
  await call("err", "error", "model-not-found", "errors", () =>
    noRetry.generate({ ...base, model: "gpt-does-not-exist", maxOutputTokens: 16 }),
  );
}

async function main(): Promise<void> {
  const packs: PackOutcome[] = [];
  for (const pack of PACKS) packs.push(await runPack(pack));
  await errorCases();
  writeFileSync(
    REPORT,
    `${JSON.stringify({ generated: new Date().toISOString(), small: SMALL, large: LARGE, spentUsdTotal: spent, rows, packs }, null, 2)}\n`,
  );
  console.log(`report: ${REPORT}; ledger total $${spent.toFixed(4)}`);
}

await main();
