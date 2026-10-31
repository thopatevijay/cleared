// LIVE (claims OPENAI; skipped without OPENAI_API_KEY or Postgres). The M2-03 live proof: one run of the
// `evidence.added` job on every item of the synthetic sample pack against the real SMALL model, compared with
// the recorded fixture's fact set (same parties, amounts and delivery event kinds). RECORD_FIXTURES=1 writes
// the exchanges to fixtures/openai/extract-v1/ instead (that run IS the recording; compare on the next run).
// Spend: usage × pricing.ts per call, logged through pino; the test stops before $0.45 cumulative.
// Run from apps/worker:
//   node --env-file=<main checkout>/.env ../../node_modules/vitest/vitest.mjs run src/jobs/extract-evidence.live.test.ts
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHttpClient, createLogger, createOpenAiCompletionProvider } from "@cleared/adapters";
import { FIXTURES_DIR } from "@cleared/adapters/testing/fixture";
import { createRecorder } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import { EXTRACT_PROMPT, parseAgentConfig } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  extractedFactsRepo,
  forWorkspace,
  withTransaction,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addedEvent,
  addSample,
  elideBody,
  factSet,
  newPack,
  newWorkspace,
  recordedFacts,
  SAMPLE_NAMES,
  SAMPLES,
  silentLog,
} from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { extractEvidence } from "./extract-evidence.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const RECORD = process.env["RECORD_FIXTURES"] === "1";
const STOP_USD = 0.45;
/** pino, not console: Vitest hides console output of passing tests, and the spend line must be kept */
const spendLog = createLogger({ service: "openai-live" });

describe.skipIf(KEY === "" || !dbAvailable)("extract-evidence LIVE (M2-03, OPENAI budget $0.50)", () => {
  const db = createDb(url);
  let boss: Queue;
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it(
    RECORD
      ? "records one facts@v1 exchange per sample item"
      : "one run on the sample pack matches the fixture fact set (parties, amounts, event kinds)",
    async () => {
      const recorder = createRecorder({
        dir: join(FIXTURES_DIR, "openai"),
        ticket: "M2-03",
        scrubber: createScrubber({ secrets: () => [KEY] }),
        env: "live",
        transform: elideBody,
      });
      const http = createHttpClient({
        vendor: "openai",
        timeoutMs: 60_000,
        ...(RECORD ? { onExchange: recorder.onExchange } : {}),
      });
      const provider = createOpenAiCompletionProvider({ apiKey: KEY, http });
      // defaults (SMALL = gpt-6-luna); the local test database carries replayed costs from other suites, so
      // the daily cap is lifted and the workspace cap ($0.10) plus the $0.45 stop below bound the spend
      const config = { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 };
      const deps = { db, publisher: createPublisher(db, boss), provider, config, now: () => new Date() };
      const ws = await newWorkspace(db, "0.10");
      const packId = await newPack(db, ws);
      let spent = 0;
      const mismatches: string[] = [];
      for (const name of SAMPLE_NAMES) {
        if (spent >= STOP_USD) throw new Error(`spend guard: $${spent.toFixed(5)} ≥ $${String(STOP_USD)}`);
        const itemId = await addSample(db, ws, packId, name);
        recorder.label(
          `extract-v1/${name}`,
          `M2-03: extract@v1 on fixtures/samples/evidence/${SAMPLES[name].file}`,
        );
        const out = await withTransaction(db, (tx) =>
          extractEvidence(deps, addedEvent(ws, packId, itemId, SAMPLES[name].kind), {
            tx,
            log: silentLog,
            envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
          }),
        );
        const runId = out.status === "written" || out.status === "no_facts" ? out.runId : null;
        const run = runId ? await forWorkspace(db, ws).agentRuns.get(runId) : null;
        const cost = Number(run?.costUsd ?? 0);
        spent += cost;
        spendLog.info(
          {
            call: `extract:${name}`,
            tokensIn: run?.tokensIn,
            tokensOut: run?.tokensOut,
            costUsd: cost,
            spentUsd: spent,
          },
          "openai live spend",
        );
        expect(out.status, name).toBe("written");
        if (RECORD) continue;
        const row = await extractedFactsRepo(db, ws).forItem(itemId, EXTRACT_PROMPT.id);
        if (!row) throw new Error(`no facts row for ${name}`);
        const live = factSet(row.facts);
        const recorded = factSet(recordedFacts(name));
        spendLog.info({ sample: name, live, recorded }, "live vs fixture fact set");
        if (JSON.stringify(live) !== JSON.stringify(recorded)) mismatches.push(name);
      }
      spendLog.info({ spentUsd: spent, mismatches }, "openai live total");
      // one exchange per item: a repair (`<name>.2`) would make the fixture's first answer an invalid one
      if (RECORD) expect(recorder.written).toEqual(SAMPLE_NAMES.map((n) => `extract-v1/${n}`));
      expect(mismatches).toEqual([]);
    },
    300_000,
  );
});
