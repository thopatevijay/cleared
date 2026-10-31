// `evidence.added` → extract@v1 (M2-03 AC) end to end: the job, runWorkflow, the OpenAI provider replaying the
// recorded `fixtures/openai/extract-v1/*` over msw, and the SQL RunStore / extracted_facts / outbox on the
// compose Postgres. The sample pack is stored exactly as M2-01's intake stores it.
import { randomUUID } from "node:crypto";
import { createHttpClient, createOpenAiCompletionProvider } from "@cleared/adapters";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import { EXTRACT_PROMPT, parseAgentConfig, type AiProvider, type WorkspaceId } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  evidenceRepo,
  extractedFactsRepo,
  forWorkspace,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumeOne } from "../consume.ts";
import {
  addedEvent,
  addSample,
  factSet,
  fixtureName,
  newPack,
  newWorkspace,
  recordedFacts,
  SAMPLE_NAMES,
  SAMPLES,
  silentLog,
  type SampleName,
} from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { extractEvidence, extractEvidenceHandler, type ExtractOutcome } from "./extract-evidence.ts";

const db = createDb(url);
let boss: Queue;
let replay: Replay | null = null;
const bodies: string[] = [];

const provider = (): AiProvider =>
  createOpenAiCompletionProvider({
    apiKey: "replay",
    http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
  });
// a shared test database accumulates replayed spend across suites: only the budget test sets a real cap
const deps = () => ({
  db,
  publisher: createPublisher(db, boss),
  provider: provider(),
  config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 },
  now: () => new Date(),
});

function serve(...names: string[]): Replay {
  replay = startReplay(names);
  replay.server.events.on("request:start", ({ request }) => {
    void request
      .clone()
      .text()
      .then((t) => bodies.push(t));
  });
  return replay;
}

async function extract(
  ws: WorkspaceId,
  packId: string,
  itemId: string,
  name: SampleName,
): Promise<ExtractOutcome> {
  return withTransaction(db, (tx) =>
    extractEvidence(deps(), addedEvent(ws, packId, itemId, SAMPLES[name].kind), {
      tx,
      log: silentLog,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
    }),
  );
}

async function outboxTopics(itemId: string): Promise<string[]> {
  const r = await db.$client.query<{ topic: string }>(
    "select topic from outbox where payload->'data'->>'evidenceItemId' = $1 and topic = 'pack.extracted'",
    [itemId],
  );
  return r.rows.map((x) => x.topic);
}

async function factRows(itemId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text as n from extracted_facts where evidence_item_id = $1",
    [itemId],
  );
  return Number(r.rows[0]?.n ?? -1);
}

async function noFactsAudit(ws: WorkspaceId, itemId: string): Promise<unknown[]> {
  const rows = await forWorkspace(db, ws).auditLog.list({ limit: 500 });
  return rows
    .filter((a) => a.action === "extract.no_facts")
    .map((a) => a.detail as { evidenceItemId: string })
    .filter((d) => d.evidenceItemId === itemId);
}

describe.skipIf(!dbAvailable)("evidence.added → extract@v1 (msw replay + compose Postgres)", () => {
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterEach(() => {
    replay?.close();
    replay = null;
    bodies.length = 0;
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it.each(SAMPLE_NAMES)(
    "AC 1 · %s: the recorded answer becomes one facts row with the item's id, and pack.extracted in the same tx",
    async (name) => {
      const ws = await newWorkspace(db);
      const packId = await newPack(db, ws);
      const itemId = await addSample(db, ws, packId, name);
      const r = serve(fixtureName(name));
      const out = await extract(ws, packId, itemId, name);
      expect(r.unused()).toEqual([]);
      expect(r.unmatched()).toEqual([]);
      expect(out.status).toBe("written");
      const row = await extractedFactsRepo(db, ws).forItem(itemId, EXTRACT_PROMPT.id);
      if (!row) throw new Error("no facts row");
      expect(row).toMatchObject({ model: "gpt-6-luna", promptVersion: "extract@v1" });
      // the stored facts are the recorded ones, every reference rewritten to the item's uuid
      expect(factSet(row.facts)).toEqual(factSet(recordedFacts(name)));
      const refs = [
        ...row.facts.parties,
        ...row.facts.amounts,
        ...row.facts.dates,
        ...row.facts.deliverables,
        ...row.facts.delivery_events,
        ...(row.facts.shipment ? [row.facts.shipment] : []),
      ].map((f) => f.evidence_item_id);
      expect(new Set(refs)).toEqual(new Set(refs.length ? [itemId] : []));
      expect(await outboxTopics(itemId)).toEqual(["pack.extracted"]);
      const run = out.status === "written" ? await forWorkspace(db, ws).agentRuns.get(out.runId) : null;
      expect(run).toMatchObject({ task: "extract", status: "succeeded", promptVersion: "extract@v1" });
    },
  );

  it("AC 1 + 2 · expected parties, amounts and delivery events per sample (sent / opened / accepted separate)", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const itemId = await addSample(db, ws, packId, "chat-delivery-events");
    serve(fixtureName("chat-delivery-events"));
    await extract(ws, packId, itemId, "chat-delivery-events");
    const row = await extractedFactsRepo(db, ws).forItem(itemId, EXTRACT_PROMPT.id);
    expect(factSet(row?.facts ?? recordedFacts("brief-logo"))).toEqual({
      parties: ["buyer:lindqvist legal ab", "seller:arjun rao translations"],
      amounts: ["180.00 EUR"],
      events: ["accepted", "opened", "sent"],
    });
    expect(row?.facts.delivery_events.map((e) => e.event)).toEqual(["sent", "opened", "accepted"]);
  });

  it("AC 5 · the image-only receipt is sent as an image part, and its facts carry that item's id", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const itemId = await addSample(db, ws, packId, "receipt-shipping");
    const item = await evidenceRepo(db, ws).items.get(itemId);
    expect(item?.text).toBeNull();
    serve(fixtureName("receipt-shipping"));
    expect((await extract(ws, packId, itemId, "receipt-shipping")).status).toBe("written");
    const body = JSON.parse(bodies[0] ?? "{}") as {
      input: { content: { type: string; image_url?: string; text?: string }[] }[];
    };
    const parts = body.input[0]?.content ?? [];
    expect(parts.map((p) => p.type)).toEqual(["input_text", "input_text", "input_image", "input_text"]);
    expect(parts[1]?.text).toMatch(
      /^<evidence id="E1" sha256="[0-9a-f]{64}" kind="image" label="shipment evidence">$/,
    );
    expect(parts[2]?.image_url).toMatch(/^data:image\/png;base64,/);
    const row = await extractedFactsRepo(db, ws).forItem(itemId, EXTRACT_PROMPT.id);
    expect(row?.facts.shipment).toMatchObject({ tracking_number: "EE123456789IN", evidence_item_id: itemId });
    expect(row?.facts.amounts.map((a) => [a.value, a.currency, a.evidence_item_id])).toEqual([
      ["1250.00", "INR", itemId],
    ]);
  });

  it("AC 3 · a fact citing an id not in the input → repair → failed_output; nothing is written", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const itemId = await addSample(db, ws, packId, "chat-delivery-events");
    const derived = "openai/extract-v1/derived-foreign-evidence-id";
    const r = serve(derived, derived);
    const out = await extract(ws, packId, itemId, "chat-delivery-events");
    expect(r.unused()).toEqual([]);
    expect(out).toMatchObject({ status: "no_facts", runStatus: "failed_output" });
    expect(await factRows(itemId)).toBe(0);
    expect(await outboxTopics(itemId)).toEqual([]);
    const runId = out.status === "no_facts" ? out.runId : null;
    const steps = (await forWorkspace(db, ws).agentSteps.list({ limit: 50 })).filter(
      (s) => s.runId === runId,
    );
    expect(steps.map((s) => [s.task, s.status]).sort()).toEqual([
      ["extract", "invalid_output"],
      ["extract:repair", "invalid_output"],
    ]);
    expect(await noFactsAudit(ws, itemId)).toEqual([
      expect.objectContaining({ runId, status: "failed_output", promptVersion: "extract@v1" }),
    ]);
  });

  it("AC 4 · re-delivering the same evidence.added job writes no second row (and a new message for the item calls no model)", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const itemId = await addSample(db, ws, packId, "brief-logo");
    const r = serve(fixtureName("brief-logo"));
    const handler = extractEvidenceHandler(deps());
    const job = (messageId: string) =>
      ({
        id: randomUUID(),
        name: "evidence.added",
        retryCount: 0,
        data: {
          messageId,
          correlationId: randomUUID(),
          workspaceId: ws,
          data: addedEvent(ws, packId, itemId, "scope"),
        },
      }) as unknown as JobWithMetadata<unknown>;
    const consumeDeps = { db, log: silentLog, now: () => new Date() };
    const messageId = randomUUID();
    expect(await consumeOne(consumeDeps, "evidence.added", handler, job(messageId))).toEqual({
      consumed: true,
    });
    expect(await consumeOne(consumeDeps, "evidence.added", handler, job(messageId))).toEqual({
      skipped: "duplicate",
    });
    expect(await consumeOne(consumeDeps, "evidence.added", handler, job(randomUUID()))).toEqual({
      consumed: true,
    });
    expect(r.unused()).toEqual([]);
    expect(r.unmatched()).toEqual([]); // the third delivery found the row and made no call
    expect(await factRows(itemId)).toBe(1);
    expect(await outboxTopics(itemId)).toEqual(["pack.extracted"]);
  });

  it("identical canned evidence in a second item is served from the content-hash cache", async () => {
    const ws = await newWorkspace(db);
    const packId = await newPack(db, ws);
    const first = await addSample(db, ws, packId, "chat-logo");
    const second = await addSample(db, ws, packId, "chat-logo");
    const r = serve(fixtureName("chat-logo"));
    expect((await extract(ws, packId, first, "chat-logo")).status).toBe("written");
    const out = await extract(ws, packId, second, "chat-logo");
    expect(r.unmatched()).toEqual([]);
    expect(out.status).toBe("written");
    const run = out.status === "written" ? await forWorkspace(db, ws).agentRuns.get(out.runId) : null;
    expect(run).toMatchObject({ status: "cache_hit", costUsd: "0" });
    const rows = await extractedFactsRepo(db, ws).listForPack(packId, EXTRACT_PROMPT.id);
    expect(rows.map((x) => x.evidenceItemId).sort()).toEqual([first, second].sort());
    expect(rows.every((x) => x.facts.parties.every((p) => p.evidence_item_id === x.evidenceItemId))).toBe(
      true,
    );
  });

  it.each([
    ["budget_exceeded", "0"],
    ["degraded", undefined],
  ] as const)("AC 6 · %s → no facts row, run status recorded, pack unchanged", async (status, budget) => {
    const ws = await newWorkspace(db, budget);
    const packId = await newPack(db, ws);
    const itemId = await addSample(db, ws, packId, "brief-logo");
    const r = serve(); // no fixture: any request gets a network error (the provider is unavailable)
    const out = await extract(ws, packId, itemId, "brief-logo");
    expect(out).toMatchObject({ status: "no_facts", runStatus: status });
    expect(r.unmatched()).toHaveLength(status === "degraded" ? 1 : 0);
    expect(await factRows(itemId)).toBe(0);
    expect(await outboxTopics(itemId)).toEqual([]);
    const runId = out.status === "no_facts" ? out.runId : null;
    expect(runId ? (await forWorkspace(db, ws).agentRuns.get(runId))?.status : null).toBe(status);
    expect((await evidenceRepo(db, ws).packs.getOwned(packId))?.state).toBe("collecting");
    expect(await noFactsAudit(ws, itemId)).toEqual([expect.objectContaining({ runId, status })]);
  });
});
