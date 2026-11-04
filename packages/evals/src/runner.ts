// `pnpm eval [--set extraction|scope|holds|adversarial|all] [--mode replay|live] [--split test|dev|all]`
// `pnpm eval:report --from-replay [--out <json>]`: the same run in replay mode, written as the report (and,
// at the default path, the README block).
// Replay is offline: msw refuses every outbound request (msw 3 `onUnhandledFrame: "error"`, formerly `onUnhandledRequest`), and recordings are
// served to the OpenAI adapter through its own fetch. A missing or changed recording fails the run with
// "recording stale". Live calls OpenAI (key from the environment, never printed), records each exchange,
// answers from the recording, and stops at `EVAL_MAX_USD` (the harness reserves each call's worst case).
// Any missed threshold exits 1 and is printed, never hidden.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { setupServer } from "msw/node";
import { evaluate, EVAL_SETS, RUN_FILE, type EvalSet, type LiveRun, type Split } from "./evaluate.ts";
import { createRecorder, STALE_MESSAGE, type EvalMode } from "./recording.ts";
import { README, readmeBlock, REPORT_JSON, withReadmeBlock, writeReport, type EvalReport } from "./report.ts";
import { createEvalStore, evalConfig } from "./store.ts";

/** Replay never spends; the cap only has to be out of the way. */
const REPLAY_CAP_USD = 1_000_000;

interface Args {
  readonly sets: EvalSet[];
  readonly mode: EvalMode;
  readonly split: Split;
  readonly report: boolean;
  readonly out: string;
  readonly concurrency: number;
}

function parse(argv: readonly string[]): Args {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== "--"),
    options: {
      set: { type: "string", default: "all" },
      mode: { type: "string", default: "replay" },
      split: { type: "string", default: "test" },
      report: { type: "boolean", default: false },
      "from-replay": { type: "boolean", default: false },
      out: { type: "string", default: REPORT_JSON },
      concurrency: { type: "string", default: "4" },
    },
  });
  const set = values.set;
  if (set !== "all" && !(EVAL_SETS as readonly string[]).includes(set)) throw new Error(`--set ${set}: use ${EVAL_SETS.join("|")}|all`);
  if (values.mode !== "replay" && values.mode !== "live") throw new Error(`--mode ${values.mode}: use replay|live`);
  if (!["test", "dev", "all"].includes(values.split)) throw new Error(`--split ${values.split}: use test|dev|all`);
  const report = values.report || values["from-replay"];
  return {
    sets: set === "all" ? [...EVAL_SETS] : [set as EvalSet],
    mode: report ? "replay" : values.mode,
    split: values.split as Split,
    report,
    out: values.out,
    concurrency: Math.max(1, Number(values.concurrency) || 4),
  };
}

function capUsd(mode: EvalMode): number {
  if (mode === "replay") return REPLAY_CAP_USD;
  const raw = process.env.EVAL_MAX_USD;
  const cap = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(cap) || cap <= 0)
    throw new Error("live eval: set EVAL_MAX_USD (the run's spend cap in USD)");
  return cap;
}

function summary(r: EvalReport): string[] {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const out: string[] = [];
  const { extraction: e, scope: s, holds: h } = r.sets;
  if (e) out.push(`extraction  n=${String(e.items)} items / ${String(e.hypotheses)} facts  accuracy ${pct(e.accuracy.rate)}  ${e.pass ? "PASS" : "MISS (≥ 90%)"}`);
  if (s) out.push(`scope       n=${String(s.items)} packs / ${String(s.hypotheses)} lines  accuracy ${pct(s.accuracy.rate)}  macro-F1 ${s.macro_f1.toFixed(3)}  verbatim ${pct(s.verbatim.rate)} (n=${String(s.verbatim.n)})  ${s.pass ? "PASS" : "MISS (≥ 90%, verbatim 100%)"}`);
  if (h) out.push(`holds       n=${String(h.items)} explanations / ${String(h.hypotheses)} facts  accuracy ${pct(h.accuracy.rate)}  ${h.pass ? "PASS" : "MISS (≥ 95%)"}`);
  if (r.adversarial) out.push(`adversarial n=${String(r.adversarial.cases.length)} cases  passed ${pct(r.adversarial.passed.rate)}  ${r.adversarial.pass ? "PASS" : "MISS (100%)"}`);
  for (const c of r.adversarial?.cases.filter((x) => !x.pass) ?? []) out.push(`  adversarial fail ${c.id}: ${c.detail}`);
  out.push(`trajectory  runs=${String(r.trajectory.runs)} max calls/run ${String(r.trajectory.max_calls_per_run)}  ${r.trajectory.pass ? "PASS" : "MISS"}`);
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const cap = capUsd(args.mode);
  const server = args.mode === "replay" ? setupServer() : null;
  server?.listen({ onUnhandledFrame: "error" }); // msw 3 name of `onUnhandledRequest`
  let spent = 0;
  let calls = 0;
  const recorder = createRecorder({
    mode: args.mode,
    ...(args.mode === "live" ? { apiKey: process.env.OPENAI_API_KEY ?? "" } : {}),
    onSpend: (s) => {
      spent += s.costUsd;
      calls += 1;
      console.log(`spend +$${s.costUsd.toFixed(6)} total $${spent.toFixed(6)} of $${cap.toFixed(2)}  ${s.model}  ${s.recording}  ${String(s.latencyMs)} ms`);
    },
  });
  const config = evalConfig(process.env, cap);
  console.log(`eval ${args.mode} sets=${args.sets.join(",")} split=${args.split} models small=${config.models.small} large=${config.models.large}`);
  if (args.mode === "live") writeLiveRun({ date: new Date().toISOString(), spend_usd: 0, cap_usd: cap, calls: 0, command: commandLine(args) });
  const { report, stale } = await evaluate(
    { recorder, store: createEvalStore(), config },
    { sets: args.sets, split: args.split, concurrency: args.concurrency, mode: args.mode, log: (l) => { console.log(l); } },
  ).finally(() => server?.close());
  if (args.mode === "live") {
    const run: LiveRun = { date: new Date().toISOString().slice(0, 10), spend_usd: Number(spent.toFixed(6)), cap_usd: cap, calls, command: commandLine(args) };
    writeLiveRun(run);
    console.log(`live spend $${spent.toFixed(6)} (cap EVAL_MAX_USD=$${cap.toFixed(2)}, ${String(calls)} calls)`);
  }
  if (stale.length > 0) {
    console.error(`${STALE_MESSAGE}\n${[...new Set(stale.map((s) => s.message))].slice(0, 20).join("\n")}`);
    return 1;
  }
  for (const line of summary(report)) console.log(line);
  if (args.report || args.mode === "live") emit(args.mode === "live" ? { ...report, live_run: readLiveRunSync() } : report, args.out);
  return report.pass ? 0 : 1;
}

function commandLine(a: Args): string {
  return `pnpm eval --mode ${a.mode} --set ${a.sets.length === 4 ? "all" : a.sets.join(",")} --split ${a.split}`;
}

function writeLiveRun(run: LiveRun): void {
  mkdirSync(dirname(RUN_FILE), { recursive: true });
  writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
}

function readLiveRunSync(): LiveRun {
  return JSON.parse(readFileSync(RUN_FILE, "utf8")) as LiveRun;
}

/** The report at `out`; at the default path also the .md and the README block. */
function emit(report: EvalReport, out: string): void {
  if (out === REPORT_JSON) {
    writeReport(report);
    writeFileSync(README, withReadmeBlock(readFileSync(README, "utf8"), readmeBlock(report)));
    console.log(`report: ${REPORT_JSON} (+ .md, README block)`);
    return;
  }
  writeReport(report, out, out.replace(/\.json$/, ".md"));
  console.log(`report: ${out}`);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
