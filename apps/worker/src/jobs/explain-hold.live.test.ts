// LIVE (claims OPENAI; skipped without OPENAI_API_KEY or Postgres). The M3-02 live proof (AC 5): one English
// and one Hindi explanation of a PENDING_REVIEW hold through the job, each recorded in agent_runs with tokens,
// cost and latency. The same run also explains a dispute hold in both locales, so the replay tests have
// answers for both rules. RECORD_FIXTURES=1 writes the four exchanges to fixtures/openai/explain_hold/.
// Spend: usage × pricing.ts from agent_runs, logged through pino; the test stops before $0.45. From apps/worker:
//   node --env-file=<main checkout>/.env ../../node_modules/vitest/vitest.mjs run src/jobs/explain-hold.live.test.ts
import { join } from "node:path";
import { createHttpClient, createLogger, createOpenAiCompletionProvider } from "@cleared/adapters";
import { FIXTURES_DIR } from "@cleared/adapters/testing/fixture";
import { createRecorder } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import { parseAgentConfig, StoredExplanationSchema, type AiProvider, type Locale } from "@cleared/core";
import { closeDb, createDb, createPublisher, createQueue, withTransaction, type Queue } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  agentRuns,
  deleteExplainJobs,
  explainCtx,
  explainWorkspace,
  heldPayment,
  holdEvent,
} from "../../test/explain-support.ts";
import { explainForEvent } from "./explain-hold.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const RECORD = process.env["RECORD_FIXTURES"] === "1";
const STOP_USD = 0.45;
const MAX_LATENCY_MS = 30_000;
const spendLog = createLogger({ service: "openai-live" });

describe.skipIf(KEY === "" || !dbAvailable)("explain-hold LIVE (M3-02, OPENAI budget $0.50)", () => {
  const db = createDb(url);
  let boss: Queue;
  let spent = 0;
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterAll(async () => {
    await deleteExplainJobs(db);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  const recorder = createRecorder({
    dir: join(FIXTURES_DIR, "openai"),
    ticket: "M3-02",
    scrubber: createScrubber({ secrets: () => [KEY] }),
    env: "live",
  });
  let inner: AiProvider | null = null; // built in the test: the SDK refuses an empty key at construction
  const live = (): AiProvider => {
    const http = createHttpClient({
      vendor: "openai",
      timeoutMs: 30_000,
      ...(RECORD ? { onExchange: recorder.onExchange } : {}),
    });
    inner ??= createOpenAiCompletionProvider({ apiKey: KEY, http });
    return inner;
  };

  async function explainLive(reason: "PENDING_REVIEW" | "BUYER_COMPLAINT", locale: Locale, name: string) {
    expect(spent).toBeLessThan(STOP_USD);
    const ws = await explainWorkspace(db, { locale });
    const { holdId } = await heldPayment(db, ws, reason);
    let call = 0;
    const provider: AiProvider = {
      complete: (req) => {
        call += 1;
        recorder.label(
          call === 1 ? `explain_hold/${name}` : `explain_hold/${name}.${String(call)}`,
          `M4-02: explain_hold@v2, ${reason} hold (synthetic 64.00 USD), locale ${locale}`,
        );
        return live().complete(req);
      },
    };
    const deps = {
      db,
      provider,
      config: parseAgentConfig(process.env),
      publisher: createPublisher(db, boss, () => explainCtx().envelope.correlationId),
      now: () => new Date(),
    };
    const out = await withTransaction(db, (tx) =>
      explainForEvent(deps, holdEvent(ws, holdId), { ...explainCtx(), tx }),
    );
    const runs = await agentRuns(db, ws);
    const cost = runs.reduce((s, r) => s + Number(r.cost_usd), 0);
    spent += cost;
    spendLog.info({ name, runs, costUsd: cost, spentUsd: spent }, "openai spend (explain_hold live)");
    const text = await db.$client.query<{ text: string; source_ref: string }>(
      "select text, source_ref from explanations where hold_id = $1",
      [holdId],
    );
    const stored = StoredExplanationSchema.parse(JSON.parse(text.rows[0]?.text ?? "null"));
    spendLog.info({ name, stored }, "explain_hold live answer");
    return { out, runs, stored, sourceRef: text.rows[0]?.source_ref };
  }

  it.each([
    ["PENDING_REVIEW", "en", "payment-review-en"],
    ["PENDING_REVIEW", "hi", "payment-review-hi"],
    ["BUYER_COMPLAINT", "en", "dispute-hold-en"],
    ["BUYER_COMPLAINT", "hi", "dispute-hold-hi"],
  ] as const)(
    "%s in %s: an AI explanation, with tokens, cost and latency in agent_runs",
    async (reason, locale, name) => {
      const { out, runs, stored, sourceRef } = await explainLive(reason, locale, name);
      expect(out).toMatchObject({ status: "written", origin: "ai", runStatus: "succeeded", locale });
      expect(stored.origin).toBe("ai");
      expect(sourceRef).toBe(reason === "PENDING_REVIEW" ? "payment_review" : "dispute_hold");
      const run = runs[0];
      expect(run?.status).toBe("succeeded");
      expect(run?.tokens_in).toBeGreaterThan(0);
      expect(run?.tokens_out).toBeGreaterThan(0);
      expect(Number(run?.cost_usd)).toBeGreaterThan(0);
      expect(run?.latency_ms).toBeLessThan(MAX_LATENCY_MS);
    },
  );
});
