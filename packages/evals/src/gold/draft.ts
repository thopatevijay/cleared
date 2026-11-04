// `pnpm eval:draft [--replay] [--out <dir>] [--only <id,…>] [--max-usd <n>]`
// Drafts the 90 UNLABELLED synthetic cases with OPENAI_MODEL_LARGE. Live: records each answer under
// fixtures/openai/gold/draft/ (a slot whose fixture exists is replayed, not re-bought, unless it is named
// in --only) and appends the run's spend to SPEND.md. --replay: no network, byte-identical output.
// Writes <out>/{extraction,scope,holds}.jsonl and <out>/generator.json (prompts + model id).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseAgentConfig } from "@cleared/core";
import {
  createLiveCaller,
  createReplayCaller,
  GOLD_FIXTURE_DIR,
  loadGoldFixture,
  type Caller,
  type CallSpec,
} from "./ai.ts";
import { buildCase, buildHoldPair, caseTask, CaseOutputSchema, holdTask, HoldOutputSchema } from "./draft-build.ts";
import { argValue, draftFile, DRAFTS_DIR, writeJson, writeJsonl } from "./io.ts";
import { allSlots, type Slot } from "./plan.ts";
import { DRAFT_INSTRUCTIONS, DRAFT_PROMPT_VERSION, HOLD_DRAFT_INSTRUCTIONS } from "./prompts.ts";
import { SETS, type DraftItem } from "./schema.ts";
import { createSpendLedger } from "./spend.ts";

const MAX_OUTPUT_TOKENS = 3_000;

function caseSpec(slot: Slot, model: string): CallSpec<typeof CaseOutputSchema> {
  return {
    name: `draft/${slot.id}`,
    model,
    schemaName: "gold_case",
    schema: CaseOutputSchema,
    instructions: DRAFT_INSTRUCTIONS,
    task: caseTask(slot),
    evidence: [],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    reasoningEffort: "none",
  };
}

function holdSpec(pair: readonly [Slot, Slot], model: string): CallSpec<typeof HoldOutputSchema> {
  return {
    name: `draft/${pair[0].hold?.pair_id ?? pair[0].id}`,
    model,
    schemaName: "gold_hold_pair",
    schema: HoldOutputSchema,
    instructions: HOLD_DRAFT_INSTRUCTIONS,
    task: holdTask(pair),
    evidence: [],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    reasoningEffort: "none",
  };
}

/** Work units: one call per extraction/scope slot, one per hold pair (EN + HI from one answer). */
type Unit = { kind: "case"; slot: Slot } | { kind: "pair"; pair: [Slot, Slot] };

function units(slots: readonly Slot[]): Unit[] {
  const out: Unit[] = [];
  for (const s of slots) {
    if (s.set !== "holds") out.push({ kind: "case", slot: s });
    else if (s.locale === "en") {
      const hi = slots.find((x) => x.id === s.id.replace(/-en$/, "-hi"));
      if (hi === undefined) throw new Error(`plan: ${s.id} has no HI twin`);
      out.push({ kind: "pair", pair: [s, hi] });
    }
  }
  return out;
}

async function runUnit(u: Unit, caller: Caller, model: string): Promise<DraftItem[]> {
  if (u.kind === "case") return [buildCase(u.slot, (await caller.call(caseSpec(u.slot, model))).value, model)];
  return buildHoldPair(u.pair, (await caller.call(holdSpec(u.pair, model))).value, model);
}

const unitName = (u: Unit): string => (u.kind === "case" ? caseSpec(u.slot, "").name : holdSpec(u.pair, "").name);

/** Live runs a few calls at once; replay runs in order (no network). */
async function runAll(list: readonly Unit[], pick: (u: Unit) => Caller, model: string, width: number): Promise<DraftItem[][]> {
  const results: DraftItem[][] = new Array<DraftItem[]>(list.length);
  const errors: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const i = next++;
      const u = list[i] as Unit;
      try {
        results[i] = await runUnit(u, pick(u), model);
      } catch (err) {
        errors.push(`${unitName(u)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (errors.length > 0) throw new Error(`draft failed for ${String(errors.length)} case(s):\n${errors.join("\n")}`);
  return results;
}

/** Replay uses the model the recording used; live uses OPENAI_MODEL_LARGE. */
function generatorModel(replay: boolean): string {
  if (!replay) return parseAgentConfig(process.env).models.large;
  const body = loadGoldFixture("draft/ext-001").request.body as { model?: unknown };
  if (typeof body.model !== "string") throw new Error("replay: draft/ext-001 has no model");
  return body.model;
}

async function main(argv: readonly string[]): Promise<void> {
  const replay = argv.includes("--replay");
  const out = argValue(argv, "--out") ?? DRAFTS_DIR;
  const only = new Set((argValue(argv, "--only") ?? "").split(",").filter(Boolean));
  const model = generatorModel(replay);
  const unitId = (u: Unit): string => (u.kind === "case" ? u.slot.id : u.pair[0].id);
  const list = units(allSlots()).filter((u) => only.size === 0 || only.has(unitId(u)));
  const ledger = createSpendLedger();
  const replayer = createReplayCaller();
  let pick: (u: Unit) => Caller = () => replayer;
  let width = 1;
  if (!replay) {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (apiKey === "") throw new Error("eval:draft: OPENAI_API_KEY is not set (use --replay for no spend)");
    const maxUsd = Number(argValue(argv, "--max-usd") ?? process.env.EVAL_MAX_USD ?? "0.25");
    const live = createLiveCaller({ apiKey, maxUsd, onSpend: (r) => { ledger.add(r.model, r.usage, r.costUsd); } });
    const recorded = (u: Unit): boolean => existsSync(join(GOLD_FIXTURE_DIR, `${unitName(u)}.json`));
    pick = (u) => (recorded(u) && !only.has(unitId(u)) ? replayer : live);
    width = 6;
  }
  try {
    const items = (await runAll(list, pick, model, width)).flat();
    if (only.size > 0) {
      console.log(`eval:draft: re-recorded ${[...only].join(", ")}; drafts not written (run without --only)`);
      return;
    }
    for (const set of SETS) writeJsonl(draftFile(set, out), items.filter((i) => i.set === set));
    writeJson(join(out, "generator.json"), generatorRecord(model));
    console.log(`eval:draft: ${String(items.length)} drafts -> ${out}`);
  } finally {
    ledger.flush(replay ? "eval:draft --replay" : "eval:draft");
  }
}

function generatorRecord(model: string): unknown {
  return {
    model,
    prompt_version: DRAFT_PROMPT_VERSION,
    reasoning_effort: "none",
    max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: DRAFT_INSTRUCTIONS,
    hold_instructions: HOLD_DRAFT_INSTRUCTIONS,
    fixtures: "fixtures/openai/gold/draft/",
  };
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
