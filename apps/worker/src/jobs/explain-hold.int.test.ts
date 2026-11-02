// M3-02 ACs end to end: the job, runWorkflow, the OpenAI provider replaying `fixtures/openai/explain_hold/*`
// (the live recordings + the derived failures) over msw, and explanations / holds / outbox / agent_runs on the
// compose Postgres. Every answer goes through the code guardrails; anything else ends in the standard text.
import { createHttpClient, createOpenAiCompletionProvider, EXPLAIN_HOLD_V1_ID } from "@cleared/adapters";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import {
  explainHoldInput,
  explainHoldProblems,
  ExplainHoldOutputSchema,
  parseAgentConfig,
  StoredExplanationSchema,
  type AiProvider,
  type Locale,
  type WorkspaceId,
} from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  holdsRepo,
  withTransaction,
  type Queue,
} from "@cleared/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  agentRuns,
  deleteExplainJobs,
  explainCtx,
  explainWorkspace,
  heldPayment,
  holdEvent,
} from "../../test/explain-support.ts";
import { explainForEvent, holdFacts, type ExplainOutcome } from "./explain-hold.ts";

const db = createDb(url);
let boss: Queue;
let replay: Replay | null = null;
let calls = 0;

const serve = (...names: string[]): Replay => {
  replay = startReplay(names.map((n) => `openai/explain_hold/${n}`));
  return replay;
};

function provider(): AiProvider {
  const inner = createOpenAiCompletionProvider({
    apiKey: "replay",
    http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
  });
  return {
    complete: (req) => {
      calls += 1;
      return inner.complete(req);
    },
  };
}

async function explain(
  ws: WorkspaceId,
  holdId: string,
  o: { locale?: Locale; env?: Record<string, string> } = {},
): Promise<ExplainOutcome> {
  const deps = {
    db,
    provider: provider(),
    // a shared test database accumulates replayed spend across suites: the daily cap is lifted
    config: { ...parseAgentConfig(o.env ?? {}), dailyCapUsd: 1_000_000 },
    publisher: createPublisher(db, boss),
    now: () => new Date("2026-10-26T12:00:00Z"),
  };
  return withTransaction(db, (tx) =>
    explainForEvent(deps, holdEvent(ws, holdId, o.locale), { ...explainCtx(), tx }),
  );
}

async function stored(holdId: string) {
  const r = await db.$client.query<{ locale: string; text: string; source_ref: string }>(
    "select locale::text, text, source_ref from explanations where hold_id = $1 order by created_at",
    [holdId],
  );
  return r.rows.map((x) => ({ ...x, doc: StoredExplanationSchema.parse(JSON.parse(x.text)) }));
}

async function holdState(holdId: string): Promise<string | undefined> {
  const r = await db.$client.query<{ state: string }>("select state::text from holds where id = $1", [
    holdId,
  ]);
  return r.rows[0]?.state;
}

async function outbox(holdId: string) {
  const r = await db.$client.query<{ payload: { data: Record<string, unknown> } }>(
    "select payload from outbox where topic = 'hold.explained' and payload->'data'->>'holdId' = $1",
    [holdId],
  );
  return r.rows.map((x) => x.payload.data);
}

/** The raw model answer of the workspace's newest explain run (slots unfilled). */
async function rawOutput(ws: WorkspaceId) {
  const r = await db.$client.query<{ output: unknown }>(
    "select output from agent_runs where workspace_id = $1 and task = 'explain_hold' order by created_at desc limit 1",
    [ws],
  );
  return ExplainHoldOutputSchema.parse(r.rows[0]?.output);
}

describe.skipIf(!dbAvailable)("explain_hold workflow (msw replay + compose Postgres)", () => {
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterEach(() => {
    if (replay) expect(replay.unmatched()).toEqual([]);
    replay?.close();
    replay = null;
    calls = 0;
  });
  afterAll(async () => {
    await deleteExplainJobs(db);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it.each([
    ["PENDING_REVIEW", "en", "payment-review-en", "payment_review"],
    ["PENDING_REVIEW", "hi", "payment-review-hi", "payment_review"],
    ["BUYER_COMPLAINT", "en", "dispute-hold-en", "dispute_hold"],
    ["BUYER_COMPLAINT", "hi", "dispute-hold-hi", "dispute_hold"],
  ] as const)(
    "AC 1: %s in %s replays an answer that passes every guardrail, ruleId matching",
    async (reason, locale, fixture, ruleId) => {
      const r = serve(fixture);
      const ws = await explainWorkspace(db, { locale });
      const { holdId } = await heldPayment(db, ws, reason);
      const out = await explain(ws, holdId);
      expect(out).toMatchObject({ status: "written", origin: "ai", runStatus: "succeeded", locale });
      expect(r.unused()).toEqual([]);
      const raw = await rawOutput(ws);
      const view = await holdsRepo(db, ws).view(holdId);
      if (view === null) throw new Error("hold missing");
      expect(explainHoldProblems(raw, explainHoldInput(holdFacts(view, "Asia/Kolkata"), locale))).toEqual([]);
      expect(raw.ruleId).toBe(ruleId);
      const [row] = await stored(holdId);
      expect(row?.source_ref).toBe(ruleId);
      expect(row?.doc).toMatchObject({ origin: "ai", locale, ruleId, promptVersion: EXPLAIN_HOLD_V1_ID });
      expect(row?.doc.summary).toContain("64.00 USD"); // code filled {amount}
      expect(row?.doc.summary).not.toMatch(/\{[a-z_]+\}/);
      // the state move and its outbox row, one transaction
      expect(await holdState(holdId)).toBe("explained");
      expect(await outbox(holdId)).toEqual([
        { holdId, explanationId: out.status === "written" ? out.explanationId : "", locale, origin: "ai" },
      ]);
    },
  );

  it('AC 2: a fabricated date ("released on 3 Nov") is rejected twice; the standard text is stored, source_ref = rule id', async () => {
    const r = serve("derived-fabricated-date", "derived-fabricated-date.2");
    const ws = await explainWorkspace(db);
    const { holdId } = await heldPayment(db, ws);
    const out = await explain(ws, holdId);
    expect(r.unused()).toEqual([]); // the answer and its one repair
    expect(out).toMatchObject({
      status: "written",
      origin: "standard",
      runStatus: "failed_output",
      fallbackReason: "date_expression",
    });
    const [row] = await stored(holdId);
    expect(row?.source_ref).toBe("payment_review");
    expect(row?.doc).toMatchObject({
      origin: "standard",
      promptVersion: "fallback@v1",
      ruleId: "payment_review",
    });
    expect(row?.doc.summary).not.toContain("3 Nov");
    expect((await agentRuns(db, ws)).map((x) => x.status)).toEqual(["failed_output"]);
    expect(await holdState(holdId)).toBe("explained");
  });

  it("AC 3: with AGENT_KILL_SWITCH=true no model call is made and the standard text is used", async () => {
    const ws = await explainWorkspace(db);
    const { holdId } = await heldPayment(db, ws);
    const out = await explain(ws, holdId, { env: { AGENT_KILL_SWITCH: "true" } });
    expect(calls).toBe(0);
    expect(out).toMatchObject({
      status: "written",
      origin: "standard",
      runStatus: "kill_switch",
      runId: null,
    });
    expect((await stored(holdId))[0]?.doc.origin).toBe("standard");
  });

  it("AC 3: with a zero workspace budget no model call is made and the standard text is used", async () => {
    const ws = await explainWorkspace(db, { budgetUsd: "0" });
    const { holdId } = await heldPayment(db, ws);
    const out = await explain(ws, holdId);
    expect(calls).toBe(0);
    expect(out).toMatchObject({ status: "written", origin: "standard", runStatus: "budget_exceeded" });
    expect((await stored(holdId))[0]?.source_ref).toBe("payment_review");
  });

  it("AC 4: a second identical hold hits the cache: no call, 0 tokens in agent_runs; another workspace does not", async () => {
    const r = serve("payment-review-en", "payment-review-en");
    const ws = await explainWorkspace(db);
    const first = await heldPayment(db, ws);
    const second = await heldPayment(db, ws, "PENDING_REVIEW", "120.50"); // same rule, reason and locale
    await explain(ws, first.holdId);
    expect(calls).toBe(1);
    const out = await explain(ws, second.holdId);
    expect(calls).toBe(1);
    expect(out).toMatchObject({ status: "written", origin: "ai", runStatus: "cache_hit" });
    const runs = await agentRuns(db, ws);
    expect(runs.map((x) => x.status)).toEqual(["succeeded", "cache_hit"]);
    expect(runs[1]).toMatchObject({ tokens_in: 0, tokens_out: 0 });
    expect(Number(runs[1]?.cost_usd)).toBe(0);
    // the cached answer carries no other hold's numbers: code filled this hold's amount
    expect((await stored(second.holdId))[0]?.doc.summary).toContain("120.50 USD");
    // owner decision 2026-11-02: the cache is per workspace
    const other = await explainWorkspace(db);
    const third = await heldPayment(db, other);
    await explain(other, third.holdId);
    expect(calls).toBe(2);
    expect(r.unused()).toEqual([]);
  });

  it("re-explains on a locale change; a repeated request or a re-delivery writes nothing", async () => {
    serve("payment-review-en", "payment-review-hi");
    const ws = await explainWorkspace(db);
    const { holdId } = await heldPayment(db, ws);
    await explain(ws, holdId);
    expect(await explain(ws, holdId)).toMatchObject({ status: "exists" });
    const hi = await explain(ws, holdId, { locale: "hi" });
    expect(hi).toMatchObject({ status: "written", locale: "hi", origin: "ai" });
    expect(await explain(ws, holdId, { locale: "hi" })).toMatchObject({ status: "exists" });
    expect((await stored(holdId)).map((x) => x.locale)).toEqual(["en", "hi"]);
    expect(await holdState(holdId)).toBe("explained"); // a re-explanation keeps the state
    expect(await outbox(holdId)).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("skips a released hold and a hold of another workspace", async () => {
    const ws = await explainWorkspace(db);
    const { holdId } = await heldPayment(db, ws);
    await db.$client.query("update holds set state = 'released' where id = $1", [holdId]);
    expect(await explain(ws, holdId)).toEqual({ status: "skipped", reason: "released" });
    const other = await explainWorkspace(db);
    const foreign = await heldPayment(db, other);
    expect(await explain(ws, foreign.holdId)).toEqual({ status: "skipped", reason: "hold_not_found" });
    expect(calls).toBe(0);
  });

  it("AC 6 (data side): markup in an answer is stored verbatim as plain text, never interpreted", async () => {
    serve("derived-html");
    const ws = await explainWorkspace(db);
    const { holdId } = await heldPayment(db, ws);
    expect(await explain(ws, holdId)).toMatchObject({ origin: "ai" });
    expect((await stored(holdId))[0]?.doc.summary).toBe(
      "<b>PayPal</b> is reviewing your payment of 64.00 USD. <img src=x onerror=alert('x')>",
    );
  });
});
