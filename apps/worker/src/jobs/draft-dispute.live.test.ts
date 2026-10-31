// LIVE (claims OPENAI; skipped without OPENAI_API_KEY or Postgres). The M2-07 live proof: one draft on the
// sample pack (the synthetic logo pack, scope-checked from M2-04's recorded answers) for the sample dispute
// (the M0-05 sandbox chargeback in WAITING_FOR_SELLER_RESPONSE, served from its recorded GET: no PayPal call).
// Only the draft_dispute@v1 call is live. Notes ≤ 2000 code points; latency (< 60 s) and cost in `agent_runs`.
// RECORD_FIXTURES=1 writes the exchange to fixtures/openai/draft-v1/logo.json (replayed by the int test).
// Spend: usage × pricing.ts, logged through pino; the test stops before $0.45. Run from apps/worker:
//   node --env-file=<main checkout>/.env ../../node_modules/vitest/vitest.mjs run src/jobs/draft-dispute.live.test.ts
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHttpClient, createLogger, createOpenAiCompletionProvider } from "@cleared/adapters";
import { FIXTURES_DIR } from "@cleared/adapters/testing/fixture";
import { createRecorder } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import { codePoints, parseAgentConfig, type AiProvider } from "@cleared/core";
import { closeDb, createDb, createQueue, forWorkspace, withTransaction, type Queue } from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteTestJobs, elideBody, silentLog } from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  checkedSamplePack,
  disputeEvent,
  DRAFT_NOW,
  sampleDispute,
  serveSampleDispute,
} from "../../test/draft-support.ts";
import { draftForTrigger } from "./draft-dispute.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const RECORD = process.env["RECORD_FIXTURES"] === "1";
const STOP_USD = 0.45;
const MAX_LATENCY_MS = 60_000;
/** pino, not console: Vitest hides console output of passing tests, and the spend line must be kept */
const spendLog = createLogger({ service: "openai-live" });

describe.skipIf(KEY === "" || !dbAvailable)("draft-dispute LIVE (M2-07, OPENAI budget $0.50)", () => {
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

  it("one draft on the sample pack: notes ≤ 2000, a valid selection, latency < 60 s and cost in agent_runs", async () => {
    const pack = await checkedSamplePack(db, boss, "0.10");
    const { ids } = await sampleDispute(db, pack, "waiting");
    const server = setupServer();
    server.listen({ onUnhandledFrame: "bypass" }); // PayPal from the recording; OpenAI goes out
    const recorder = createRecorder({
      dir: join(FIXTURES_DIR, "openai"),
      ticket: "M2-07",
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
    let call = 0;
    const provider: AiProvider = {
      complete: (req) => {
        call += 1;
        const name = call === 1 ? "draft-v1/logo" : `draft-v1/logo.${String(call)}`;
        recorder.label(name, "M2-07: draft_dispute@v1 on the logo sample pack + the M0-05 sample dispute");
        return inner.complete(req);
      },
    };
    try {
      const deps = {
        db,
        provider,
        config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 },
        disputes: serveSampleDispute(server, ids, pack.ws, "waiting"),
        now: () => DRAFT_NOW,
      };
      const [out] = await withTransaction(db, (tx) =>
        draftForTrigger(deps, disputeEvent(pack.ws, ids, "WAITING_FOR_SELLER_RESPONSE"), {
          tx,
          log: silentLog,
          envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
        }),
      );
      const runId = out?.status === "written" || out?.status === "unavailable" ? out.runId : null;
      const run = runId ? await forWorkspace(db, pack.ws).agentRuns.get(runId) : null;
      const cost = Number(run?.costUsd ?? 0);
      spendLog.info(
        {
          call: "draft_dispute:logo",
          model: run?.model,
          tokensIn: run?.tokensIn,
          tokensOut: run?.tokensOut,
          costUsd: cost,
          latencyMs: run?.latencyMs,
          spentUsd: cost,
        },
        "openai live spend",
      );
      expect(cost).toBeLessThan(STOP_USD);
      expect(out).toMatchObject({ status: "written", kind: "provide_evidence" });
      expect(run).toMatchObject({ task: "draft_dispute", status: "succeeded", model: "gpt-6.1-terra" });
      expect(cost).toBeGreaterThan(0);
      expect(run?.latencyMs ?? Infinity).toBeLessThan(MAX_LATENCY_MS);
      const draft =
        out?.status === "written" ? await forWorkspace(db, pack.ws).disputeDrafts.get(out.draftId) : null;
      expect(codePoints(draft?.notes ?? "x".repeat(2001))).toBeLessThanOrEqual(2000);
      expect((draft?.evidenceItemIds ?? []).every((id) => pack.itemIds.includes(id))).toBe(true);
      spendLog.info(
        {
          notes: draft?.notes,
          items: draft?.evidenceItemIds.length,
          factRefs: draft?.factRefs,
          written: recorder.written,
        },
        "live dispute draft",
      );
    } finally {
      server.close();
    }
  }, 180_000);
});
