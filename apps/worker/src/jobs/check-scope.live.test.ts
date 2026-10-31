// LIVE (claims OPENAI; skipped without OPENAI_API_KEY or Postgres). The M2-04 live proof: one run of the
// `pack.extracted` job on the synthetic logo sample pack against the real LARGE model (check_scope@v1), plus
// the translation pack (BL-01 6488851866: the spike prompts misgraded it). Every stored citation must pass the
// verbatim check again, and the run's cost and latency are in `agent_runs` (< 30 s). RECORD_FIXTURES=1 also
// writes the exchanges to fixtures/openai/scope-v1/<pack>-pass{1,2}.json (replayed by check-scope.int.test.ts).
// Spend: usage × pricing.ts per run, logged through pino; the test stops before $0.45 cumulative.
// The items are settled with the recorded extract-v1 facts (no extract call). Run from apps/worker:
//   node --env-file=<main checkout>/.env ../../node_modules/vitest/vitest.mjs run src/jobs/check-scope.live.test.ts
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHttpClient, createLogger, createOpenAiCompletionProvider } from "@cleared/adapters";
import { FIXTURES_DIR } from "@cleared/adapters/testing/fixture";
import { createRecorder } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import { citationIndex, normaliseForQuote, verifyCitation } from "@cleared/core/proof/verbatim";
import { parseAgentConfig, type AiProvider } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  evidenceRepo,
  forWorkspace,
  scopeChecksRepo,
  withTransaction,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteTestJobs, elideBody, newPack, newWorkspace, silentLog } from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { extractedEvent, SPIKE_PACKS, storePack, type SpikePack } from "../../test/scope-support.ts";
import { checkScope } from "./check-scope.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const RECORD = process.env["RECORD_FIXTURES"] === "1";
const STOP_USD = 0.45;
const MAX_LATENCY_MS = 30_000;
const PACKS: readonly SpikePack[] = ["logo", "translation"];
/** pino, not console: Vitest hides console output of passing tests, and the spend line must be kept */
const spendLog = createLogger({ service: "openai-live" });

describe.skipIf(KEY === "" || !dbAvailable)("check-scope LIVE (M2-04, OPENAI budget $0.50)", () => {
  const db = createDb(url);
  let boss: Queue;
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterAll(async () => {
    await deleteTestJobs(db);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("one run per sample pack: every stored citation passes the verbatim check; cost and latency (< 30 s) recorded", async () => {
    const recorder = createRecorder({
      dir: join(FIXTURES_DIR, "openai"),
      ticket: "M2-04",
      scrubber: createScrubber({ secrets: () => [KEY] }),
      env: "live",
      transform: elideBody,
    });
    const http = createHttpClient({
      vendor: "openai",
      timeoutMs: 60_000,
      ...(RECORD ? { onExchange: recorder.onExchange } : {}),
    });
    const inner = createOpenAiCompletionProvider({ apiKey: KEY, http });
    let label = "";
    let call = 0;
    // names each exchange `<pack>-pass1` / `<pack>-pass2` (a repair would be `<pack>-pass2.2`)
    const provider: AiProvider = {
      complete: (req) => {
        call += 1;
        recorder.label(
          `scope-v1/${label}-pass${String(Math.min(call, 2))}`,
          `M2-04: check_scope@v1 on the ${label} sample pack`,
        );
        return inner.complete(req);
      },
    };
    // defaults (LARGE = gpt-6.1-terra); the local test database carries replayed costs from other suites, so
    // the daily cap is lifted and the workspace cap ($0.10) plus the $0.45 stop below bound the spend
    const config = { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 };
    const deps = { db, publisher: createPublisher(db, boss), provider, config, now: () => new Date() };
    let spent = 0;
    for (const pack of PACKS) {
      if (spent >= STOP_USD) throw new Error(`spend guard: $${spent.toFixed(5)} ≥ $${String(STOP_USD)}`);
      label = pack;
      call = 0;
      const ws = await newWorkspace(db, "0.10");
      const packId = await newPack(db, ws);
      const ids = await storePack(db, ws, packId, SPIKE_PACKS[pack]);
      const out = await withTransaction(db, (tx) =>
        checkScope(deps, extractedEvent(ws, packId, ids.at(-1) ?? ""), {
          tx,
          log: silentLog,
          envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
        }),
      );
      const runId = out.status === "written" || out.status === "unavailable" ? out.runId : null;
      const run = runId ? await forWorkspace(db, ws).agentRuns.get(runId) : null;
      const cost = Number(run?.costUsd ?? 0);
      spent += cost;
      spendLog.info(
        {
          call: `check_scope:${pack}`,
          model: run?.model,
          tokensIn: run?.tokensIn,
          tokensOut: run?.tokensOut,
          costUsd: cost,
          latencyMs: run?.latencyMs,
          spentUsd: spent,
        },
        "openai live spend",
      );
      expect(out.status, pack).toBe("written");
      expect(run).toMatchObject({ task: "check_scope", status: "succeeded", model: "gpt-6.1-terra" });
      expect(cost).toBeGreaterThan(0);
      expect(run?.latencyMs ?? Infinity).toBeLessThan(MAX_LATENCY_MS);

      const rows = await scopeChecksRepo(db, ws).latestForPack(packId);
      const items = await evidenceRepo(db, ws).items.listForPack(packId);
      const index = citationIndex(items.map((i) => ({ ref: i.id, sha256: i.sha256, text: i.text })));
      const text = new Map(items.map((i) => [i.id, i.text ?? ""] as const));
      let citations = 0;
      for (const row of rows)
        for (const c of [...row.citations, ...(row.lineCitation ? [row.lineCitation] : [])]) {
          citations += 1;
          expect(verifyCitation(c.evidence_item_id, c.quote, index)).toMatchObject({
            ok: true,
            sha256: c.sha256,
          });
          expect(
            normaliseForQuote(text.get(c.evidence_item_id) ?? "").slice(c.offsets.start, c.offsets.end),
          ).toBe(c.quote);
        }
      spendLog.info(
        {
          pack,
          citations,
          verdicts: rows.map(
            (r) => `${r.lineId} ${r.modelVerdict}->${r.verdict}${r.note ? `:${r.note}` : ""}`,
          ),
          lines: rows.map((r) => `${r.lineId} ${r.line}`),
        },
        "live scope check",
      );
      expect(citations).toBeGreaterThan(0);
    }
    spendLog.info({ spentUsd: spent, written: recorder.written }, "openai live total");
  }, 300_000);
});
