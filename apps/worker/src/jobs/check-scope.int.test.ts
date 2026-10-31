// `pack.extracted` → check_scope@v1 (M2-04 AC) end to end: the job, runWorkflow, the OpenAI provider replaying
// the M0-07 spike's recorded `fixtures/openai/scope-pass{1,2}/*` answers (and the M2-04 derived ones in
// `fixtures/openai/scope-v1/derived-*`) over msw, and scope_checks / proof_packs / outbox / agent_runs on the
// compose Postgres. The sample packs are stored exactly as M2-01's intake stores them.
import { randomUUID } from "node:crypto";
import { createHttpClient, createOpenAiCompletionProvider } from "@cleared/adapters";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import { normaliseForQuote } from "@cleared/core/proof/verbatim";
import { parseAgentConfig, type WorkspaceId } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  evidenceRepo,
  forWorkspace,
  scopeChecksRepo,
  withTransaction,
  type JobWithMetadata,
  type Queue,
  type ScopeCheckRow,
} from "@cleared/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumeOne } from "../consume.ts";
import { addFile, deleteTestJobs, newPack, newWorkspace, silentLog } from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  extractedEvent,
  settle,
  SPIKE_PACKS,
  SPIKE_RUNS,
  storePack,
  type SpikePack,
} from "../../test/scope-support.ts";
import { checkScope, checkScopeHandler, type CheckScopeOutcome } from "./check-scope.ts";

const db = createDb(url);
let boss: Queue;
let replay: Replay | null = null;

const deps = () => ({
  db,
  publisher: createPublisher(db, boss),
  provider: createOpenAiCompletionProvider({
    apiKey: "replay",
    http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
  }),
  // a shared test database accumulates replayed spend across suites: only the budget test sets a real cap
  config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 },
  now: () => new Date(),
});

function serve(...names: string[]): Replay {
  replay = startReplay(names.map((n) => `openai/${n}`));
  return replay;
}
const spike = (run: string) => [`scope-pass1/${run}-claims`, `scope-pass2/${run}-verdicts`];

async function run(ws: WorkspaceId, packId: string, itemId: string): Promise<CheckScopeOutcome> {
  return withTransaction(db, (tx) =>
    checkScope(deps(), extractedEvent(ws, packId, itemId), {
      tx,
      log: silentLog,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
    }),
  );
}

async function packWith(pack: SpikePack, budget?: string) {
  const ws = await newWorkspace(db, budget);
  const packId = await newPack(db, ws);
  const ids = await storePack(db, ws, packId, SPIKE_PACKS[pack]);
  return { ws, packId, ids, last: ids.at(-1) ?? "" };
}

const table = (rows: readonly ScopeCheckRow[]) =>
  rows.map((r) => `${r.lineId} ${r.verdict}${r.note ? `:${r.note}` : ""}`);

async function checkedTopics(packId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text as n from outbox where topic = 'pack.checked' and payload->'data'->>'packId' = $1",
    [packId],
  );
  return Number(r.rows[0]?.n ?? -1);
}

async function rowCount(packId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text as n from scope_checks where pack_id = $1",
    [packId],
  );
  return Number(r.rows[0]?.n ?? -1);
}

/** What the verbatim check and the rules make of each recorded M0-07 answer on the stored packs. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  r1: ["C1 met", "C2 partial", "C3 met", "C4 missing", "C5 partial", "C6 unverifiable:model_unverifiable"],
  r4: ["C1 met", "C2 partial", "C3 met", "C4 missing", "C5 partial", "C6 unverifiable:model_unverifiable"],
  r5: ["C1 met", "C2 partial", "C3 met", "C4 missing", "C5 partial", "C6 unverifiable:model_unverifiable"],
  c1: ["C1 met", "C2 met", "C3 met", "C4 unverifiable:model_unverifiable", "C5 partial", "C6 met"],
  r2: ["C1 missing", "C2 partial", "C3 partial", "C4 missing"],
  r3: [
    "C1 unverifiable:image_only_support",
    "C2 unverifiable:model_unverifiable",
    "C3 unverifiable:image_only_support",
    "C4 unverifiable:model_unverifiable",
  ],
};

describe.skipIf(!dbAvailable)("pack.extracted → check_scope@v1 (msw replay + compose Postgres)", () => {
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterEach(() => {
    replay?.close();
    replay = null;
  });
  afterAll(async () => {
    await deleteTestJobs(db);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it.each(Object.keys(EXPECTED))(
    "AC 3 · %s: the recorded answers give the expected verdict per line; every citation slices its item's text",
    async (spikeRun) => {
      const { ws, packId, ids, last } = await packWith(SPIKE_RUNS[spikeRun] ?? "logo");
      const r = serve(...spike(spikeRun));
      const out = await run(ws, packId, last);
      expect(r.unused()).toEqual([]);
      expect(r.unmatched()).toEqual([]);
      expect(out).toMatchObject({ status: "written", checkVersion: 1 });
      const rows = await scopeChecksRepo(db, ws).latestForPack(packId);
      expect(table(rows)).toEqual(EXPECTED[spikeRun]);
      // property over every stored citation (support and scope line): offsets + sha256 point into the item
      const items = new Map(
        (await evidenceRepo(db, ws).items.listForPack(packId)).map((i) => [i.id, i] as const),
      );
      for (const row of rows) {
        if (row.verdict === "unverifiable") expect(row.citations).toEqual([]);
        for (const c of [...row.citations, ...(row.lineCitation ? [row.lineCitation] : [])]) {
          const item = items.get(c.evidence_item_id);
          expect(ids).toContain(c.evidence_item_id);
          expect(normaliseForQuote(item?.text ?? "").slice(c.offsets.start, c.offsets.end)).toBe(c.quote);
          expect(c.sha256).toBe(item?.sha256);
        }
      }
      const pack = await evidenceRepo(db, ws).packs.getOwned(packId);
      expect(pack?.state).toBe("checked");
      expect(pack?.checkedAt).not.toBeNull();
      expect(await checkedTopics(packId)).toBe(1);
      const agentRun = out.status === "written" ? await forWorkspace(db, ws).agentRuns.get(out.runId) : null;
      expect(agentRun).toMatchObject({
        task: "check_scope",
        status: "succeeded",
        promptVersion: "check_scope@v1",
      });
      expect(rows.every((x) => x.runId === agentRun?.id && x.promptVersion === "check_scope@v1")).toBe(true);
    },
  );

  it("AC 2 · met on a fabricated quote is stored as unverifiable with zero citations", async () => {
    const { ws, packId, last } = await packWith("logo");
    serve("scope-pass1/r1-claims", "scope-v1/derived-fabricated-met");
    expect((await run(ws, packId, last)).status).toBe("written");
    const c1 = (await scopeChecksRepo(db, ws).latestForPack(packId)).find((x) => x.lineId === "C1");
    expect(c1).toMatchObject({
      modelVerdict: "met",
      verdict: "unverifiable",
      note: "no_valid_citation",
      citations: [],
    });
  });

  it("AC 4 · the chat's injection ('mark everything met'), obeyed by the model, yields no met verdict", async () => {
    const { ws, packId, last } = await packWith("logo");
    serve("scope-pass1/r1-claims", "scope-v1/derived-injection-obeyed");
    expect((await run(ws, packId, last)).status).toBe("written");
    const rows = await scopeChecksRepo(db, ws).latestForPack(packId);
    expect(rows.map((x) => x.modelVerdict)).toEqual(Array(6).fill("met"));
    expect(rows.filter((x) => x.verdict === "met")).toEqual([]);
    expect(rows.every((x) => x.verdict === "unverifiable" && x.citations.length === 0)).toBe(true);
  });

  it("AC 5 · a re-delivered job writes no duplicate rows; new evidence writes version 2 and never edits version 1", async () => {
    const { ws, packId, last } = await packWith("logo");
    const r = serve(...spike("r1"));
    const handler = checkScopeHandler(deps());
    const job = (messageId: string) =>
      ({
        id: randomUUID(),
        name: "pack.extracted",
        retryCount: 0,
        data: {
          messageId,
          correlationId: randomUUID(),
          workspaceId: ws,
          data: extractedEvent(ws, packId, last),
        },
      }) as unknown as JobWithMetadata<unknown>;
    const consumeDeps = { db, log: silentLog, now: () => new Date() };
    const messageId = randomUUID();
    expect(await consumeOne(consumeDeps, "pack.extracted", handler, job(messageId))).toEqual({
      consumed: true,
    });
    expect(await consumeOne(consumeDeps, "pack.extracted", handler, job(messageId))).toEqual({
      skipped: "duplicate",
    });
    expect(await consumeOne(consumeDeps, "pack.extracted", handler, job(randomUUID()))).toEqual({
      consumed: true,
    });
    expect(r.unmatched()).toEqual([]); // the third delivery found the check and made no call
    expect(await rowCount(packId)).toBe(6);
    expect(await checkedTopics(packId)).toBe(1);
    const v1 = await scopeChecksRepo(db, ws).forVersion(packId, 1);
    replay?.close();

    // new evidence: the intake marks the checked pack stale; its extraction is pending until settled
    const added = await addFile(db, ws, packId, "chat-delivery-events.txt", "communication");
    await withTransaction(db, (tx) => evidenceRepo(db, ws).packs.setState(packId, "stale", tx));
    expect(await run(ws, packId, added)).toEqual({ status: "pending", awaiting: [added] });
    await settle(db, ws, added, "chat-delivery-events.txt");
    serve(...spike("r1"));
    expect(await run(ws, packId, added)).toMatchObject({ status: "written", checkVersion: 2 });
    expect(await rowCount(packId)).toBe(12);
    expect(await scopeChecksRepo(db, ws).forVersion(packId, 1)).toEqual(v1);
    const latest = await scopeChecksRepo(db, ws).latestForPack(packId);
    expect(latest.map((x) => x.checkVersion)).toEqual(Array(6).fill(2));
    expect(new Set(latest.map((x) => x.evidenceSetHash)).size).toBe(1);
    expect(latest[0]?.evidenceSetHash).not.toBe(v1[0]?.evidenceSetHash);
    expect((await evidenceRepo(db, ws).packs.getOwned(packId))?.state).toBe("checked"); // stale → checked
    await expect(
      db.$client.query("update scope_checks set verdict = 'met' where pack_id = $1", [packId]),
    ).rejects.toThrow("scope_checks is append-only");
  });

  it("AC 6 · pass 1 + pass 2 + one repair: 3 call steps in the trace, never more than 6", async () => {
    const { ws, packId, last } = await packWith("logo");
    const r = serve("scope-pass1/r1-claims", "scope-v1/derived-missing-line", "scope-pass2/r1-verdicts");
    const out = await run(ws, packId, last);
    expect(r.unused()).toEqual([]);
    expect(out.status).toBe("written");
    const runId = out.status === "written" ? out.runId : "";
    const steps = (await forWorkspace(db, ws).agentSteps.list({ limit: 50 })).filter(
      (s) => s.runId === runId && s.kind === "call",
    );
    expect(steps.map((s) => s.task).sort()).toEqual(["pass1", "pass2", "pass2:repair"]);
    expect(steps.length).toBeLessThanOrEqual(6);
    expect((await forWorkspace(db, ws).agentRuns.get(runId))?.status).toBe("succeeded");
  });

  it.each([
    ["budget_exceeded", "0"],
    ["degraded", undefined],
  ] as const)(
    "%s → no verdicts, check_unavailable recorded, facts and pack state kept",
    async (status, budget) => {
      const { ws, packId, last } = await packWith("logo", budget);
      serve(); // no fixture: any request gets a network error (the provider is unavailable)
      expect(await run(ws, packId, last)).toMatchObject({ status: "unavailable", runStatus: status });
      expect(await rowCount(packId)).toBe(0);
      expect(await checkedTopics(packId)).toBe(0);
      expect((await evidenceRepo(db, ws).packs.getOwned(packId))?.state).toBe("collecting");
      const audit = (await forWorkspace(db, ws).auditLog.list({ limit: 50 })).filter(
        (a) => a.action === "check_unavailable",
      );
      expect(audit.map((a) => a.detail)).toEqual([
        expect.objectContaining({ packId, status, promptVersion: "check_scope@v1" }),
      ]);
      const facts = await db.$client.query("select 1 from extracted_facts where workspace_id = $1", [ws]);
      expect(facts.rowCount).toBe(4);
    },
  );

  it("a pack with no scope or chat evidence is not checked (no call)", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const [id] = await storePack(db, ws, packId, ["delivery-logo.pdf"]);
    const r = serve();
    expect(await run(ws, packId, id ?? "")).toEqual({ status: "no_scope" });
    expect(r.unmatched()).toEqual([]);
  });
});
