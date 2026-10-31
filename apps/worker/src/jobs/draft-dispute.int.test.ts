// M2-07 ACs end to end: the job, runWorkflow, the OpenAI provider replaying `fixtures/openai/draft-v1/*` (the
// live recording + the derived failures) over msw, the real PayPal disputes client reading the recorded M0-05
// GETs, the PDF compiler, and dispute_drafts / blobs / proposed_actions / audit_log on the compose Postgres.
// The proposal then goes through M2-08's approval (`approveProposedAction`): no INVALID_PAYLOAD (BL-01 6537330886).
import { createHash, randomUUID } from "node:crypto";
import { createHttpClient, createOpenAiCompletionProvider } from "@cleared/adapters";
import { extractPdfText } from "@cleared/adapters/files";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import { canonicalHash, codePoints, parseAgentConfig, type WorkspaceId } from "@cleared/core";
import {
  approveProposedAction,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  disputeDraftsRepo,
  forWorkspace,
  getProposedAction,
  withTransaction,
  type Queue,
} from "@cleared/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deleteTestJobs, silentLog } from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  checkedSamplePack,
  disputeEvent,
  DRAFT_NOW,
  packCheckedEvent,
  sampleDispute,
  serveSampleDispute,
  type DisputeState,
  type SamplePack,
} from "../../test/draft-support.ts";
import { draftForTrigger, type DraftDisputeOutcome } from "./draft-dispute.ts";

const db = createDb(url);
let boss: Queue;
let replay: Replay | null = null;

const serve = (...names: string[]): Replay => {
  replay = startReplay(names.map((n) => `openai/draft-v1/${n}`));
  return replay;
};

async function draft(
  pack: SamplePack,
  ids: { disputeId: string; captureId: string },
  state: DisputeState,
  event: unknown = disputeEvent(pack.ws, ids, "WAITING_FOR_SELLER_RESPONSE"),
): Promise<DraftDisputeOutcome[]> {
  if (!replay) throw new Error("serve() first");
  const deps = {
    db,
    provider: createOpenAiCompletionProvider({
      apiKey: "replay",
      http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
    }),
    // a shared test database accumulates replayed spend across suites: the daily cap is lifted
    config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 },
    disputes: serveSampleDispute(replay.server, ids, pack.ws, state),
    now: () => DRAFT_NOW,
  };
  return withTransaction(db, (tx) =>
    draftForTrigger(deps, event, {
      tx,
      log: silentLog,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
    }),
  );
}

async function count(table: "dispute_drafts" | "proposed_actions", ws: WorkspaceId): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    `select count(*)::text as n from ${table} where workspace_id = $1`,
    [ws],
  );
  return Number(r.rows[0]?.n ?? -1);
}

async function audit(ws: WorkspaceId, action: string) {
  const r = await db.$client.query<{ detail: Record<string, unknown> }>(
    "select detail from audit_log where workspace_id = $1 and action = $2",
    [ws, action],
  );
  return r.rows.map((x) => x.detail);
}

describe.skipIf(!dbAvailable)("dispute draft workflow (msw replay + compose Postgres)", () => {
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

  it("AC 2 · sample dispute + sample pack: notes ≤ 2000, valid ids, a draft and a proposal with payload_sha256 = canonicalHash(payload); M2-08 approves it", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids, rowId } = await sampleDispute(db, pack, "waiting");
    const r = serve("logo");
    const [out] = await draft(pack, ids, "waiting");
    expect(r.unused()).toEqual([]);
    expect(r.unmatched()).toEqual([]);
    if (out?.status !== "written") throw new Error(JSON.stringify(out));
    // PayPal's request (PROOF_OF_FULFILLMENT first) wins over the table's OTHER for not-as-described
    expect(out).toMatchObject({ kind: "provide_evidence", evidenceType: "PROOF_OF_FULFILLMENT" });

    const ws = forWorkspace(db, pack.ws);
    const row = await ws.disputeDrafts.get(out.draftId);
    expect(row).toMatchObject({
      disputeId: rowId,
      packId: pack.packId,
      checkVersion: 1,
      actionKind: "provide_evidence",
      evidenceType: "PROOF_OF_FULFILLMENT",
      reasonUnmapped: false,
      runId: out.runId,
      proposedActionId: out.actionId,
      state: "draft_ready",
    });
    expect(codePoints(row?.notes ?? "")).toBeLessThanOrEqual(2000);
    expect(row?.evidenceItemIds.length).toBeGreaterThan(0);
    for (const id of row?.evidenceItemIds ?? []) expect(pack.itemIds).toContain(id);

    const action = await getProposedAction(db, pack.ws, out.actionId);
    const payload = action?.payload as Record<string, unknown>;
    expect(payload).toEqual({
      dispute_id: ids.disputeId,
      evidence_type: "PROOF_OF_FULFILLMENT",
      notes: row?.notes,
      compiled_blob_sha256: out.compiledSha256,
      draft_id: out.draftId,
    });
    expect(action?.payloadSha256).toBe(canonicalHash(payload as never));
    expect(row?.sha256).toBe(action?.payloadSha256);
    expect(action).toMatchObject({ kind: "provide_evidence", state: "proposed", createdByRunId: out.runId });

    // the compiled blob M2-08 loads by compiled_blob_id hashes to the payload's compiled_blob_sha256
    const blob = row?.compiledBlobId ? await ws.blobs.get(row.compiledBlobId) : null;
    const bytes = new Uint8Array(blob?.bytes ?? []);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(payload["compiled_blob_sha256"]);
    expect(blob?.mime).toBe("application/pdf");
    expect(bytes.byteLength).toBeLessThan(10_000_000);
    // the cover names the dispute and lists every selected item's sha256
    const text = (await extractPdfText(bytes)) ?? "";
    expect(text).toContain(ids.disputeId);
    const items = await ws.evidenceItems.list();
    for (const id of row?.evidenceItemIds ?? [])
      expect(text).toContain(items.find((i) => i.id === id)?.sha256 ?? "missing");

    // every fact ref resolved to an item of the pack (or a scope line)
    const refs = (row?.factRefs ?? []) as { refs: { kind: string; evidence_item_id: string | null }[] }[];
    for (const r2 of refs.flatMap((p) => p.refs))
      if (r2.kind !== "line") expect(pack.itemIds).toContain(r2.evidence_item_id);

    const approved = await approveProposedAction(db, createPublisher(db, boss), {
      workspaceId: pack.ws,
      actionId: out.actionId,
      actor: "seller-test",
      now: DRAFT_NOW,
      payloadSha256: out.payloadSha256,
    });
    expect(approved).toMatchObject({ ok: true, action: { state: "approved" } });
  });

  it("AC 6 · with only provide_supporting_info in the links the proposal kind is provide_supporting_info", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "underReview");
    serve("logo");
    const [out] = await draft(pack, ids, "underReview", disputeEvent(pack.ws, ids, "UNDER_REVIEW"));
    if (out?.status !== "written") throw new Error(JSON.stringify(out));
    expect(out.kind).toBe("provide_supporting_info");
    // no evidence requested yet in UNDER_REVIEW: the reason table decides
    expect(out.evidenceType).toBe("OTHER");
    const action = await getProposedAction(db, pack.ws, out.actionId);
    expect(action?.kind).toBe("provide_supporting_info");
    expect(Object.keys(action?.payload as object).sort()).toEqual([
      "compiled_blob_sha256",
      "dispute_id",
      "draft_id",
      "notes",
    ]);
    const approved = await approveProposedAction(db, createPublisher(db, boss), {
      workspaceId: pack.ws,
      actionId: out.actionId,
      actor: "seller-test",
      now: DRAFT_NOW,
      payloadSha256: out.payloadSha256,
    });
    expect(approved.ok).toBe(true);
  });

  it("AC 3 · notes of 2,400 chars → one repair → fail with notes_too_long; nothing stored", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "waiting");
    const r = serve("derived-too-long", "derived-too-long.2");
    const [out] = await draft(pack, ids, "waiting");
    expect(r.unused()).toEqual([]); // the call and its one repair
    expect(out).toMatchObject({ status: "unavailable", code: "notes_too_long", runStatus: "failed_output" });
    expect(await count("dispute_drafts", pack.ws)).toBe(0);
    expect(await count("proposed_actions", pack.ws)).toBe(0);
    expect(await audit(pack.ws, "dispute_draft.unavailable")).toMatchObject([
      { code: "notes_too_long", status: "failed_output", actionKind: "provide_evidence", checkVersion: 1 },
    ]);
    const run =
      out?.status === "unavailable" && out.runId
        ? await forWorkspace(db, pack.ws).agentRuns.get(out.runId)
        : null;
    expect(run).toMatchObject({ task: "draft_dispute", status: "failed_output" });
  });

  it.each([
    ["derived-invented-id", "unknown_evidence_id"],
    ["derived-url", "foreign_contact"],
  ])("AC 4 · %s fails validation (%s); nothing stored", async (fixture, code) => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "waiting");
    const r = serve(fixture, `${fixture}.2`);
    const [out] = await draft(pack, ids, "waiting");
    expect(r.unused()).toEqual([]);
    expect(out).toMatchObject({ status: "unavailable", code, runStatus: "failed_output" });
    expect(await count("dispute_drafts", pack.ws)).toBe(0);
    expect(await count("proposed_actions", pack.ws)).toBe(0);
  });

  it("AC 7 · a re-delivered trigger (and the pack.checked one) creates no second draft", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "waiting");
    const r = serve("logo");
    const [first] = await draft(pack, ids, "waiting");
    expect(first?.status).toBe("written");
    const draftId = first?.status === "written" ? first.draftId : "";
    expect(await draft(pack, ids, "waiting")).toEqual([{ status: "exists", draftId }]);
    expect(await draft(pack, ids, "waiting", packCheckedEvent(pack.ws, pack.packId))).toEqual([
      { status: "exists", draftId },
    ]);
    expect(r.unmatched()).toEqual([]); // no second model call
    expect(await count("dispute_drafts", pack.ws)).toBe(1);
    expect(await count("proposed_actions", pack.ws)).toBe(1);
  });

  it("pack.checked drafts for the open dispute on the pack's payment", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { rowId, ids } = await sampleDispute(db, pack, "waiting");
    serve("logo");
    const outs = await draft(pack, ids, "waiting", packCheckedEvent(pack.ws, pack.packId));
    expect(outs).toMatchObject([{ status: "written", kind: "provide_evidence" }]);
    expect(await disputeDraftsRepo(db, pack.ws).listForDispute(rowId)).toHaveLength(1);
  });

  it("AC 7 · a closed_for_action dispute is not drafted: too_late, recorded once, no model call", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids, rowId } = await sampleDispute(db, pack, "waiting");
    await forWorkspace(db, pack.ws).disputes.setDeadlineState(rowId, "closed_for_action");
    const r = serve();
    expect(await draft(pack, ids, "waiting")).toEqual([{ status: "too_late" }]);
    expect(await draft(pack, ids, "waiting")).toEqual([{ status: "too_late" }]);
    expect(r.unmatched()).toEqual([]);
    expect(await count("dispute_drafts", pack.ws)).toBe(0);
    expect(await audit(pack.ws, "dispute_draft.too_late")).toMatchObject([
      { disputeId: rowId, checkVersion: 1, actionKind: "provide_evidence", paypalDisputeId: ids.disputeId },
    ]);
  });

  it("the fresh due date also gates: within the last hour before it the draft is too_late", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "waiting");
    const r = serve();
    const deps = {
      db,
      provider: createOpenAiCompletionProvider({ apiKey: "replay" }),
      config: parseAgentConfig({}),
      disputes: serveSampleDispute(r.server, ids, pack.ws, "waiting"),
      now: () => new Date("2026-11-09T04:00:00.000Z"), // due 04:59:59 − 60 min
    };
    const out = await withTransaction(db, (tx) =>
      draftForTrigger(deps, disputeEvent(pack.ws, ids, "WAITING_FOR_SELLER_RESPONSE"), {
        tx,
        log: silentLog,
        envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
      }),
    );
    expect(out).toEqual([{ status: "too_late" }]);
    expect(r.unmatched()).toEqual([]);
  });

  it("a pack that is not checked, or a dispute without an evidence action, is skipped before any call", async () => {
    const pack = await checkedSamplePack(db, boss);
    const { ids } = await sampleDispute(db, pack, "waiting");
    await withTransaction(db, (tx) =>
      forWorkspace(db, pack.ws).proofPacks.update(pack.packId, { state: "stale" }, tx),
    );
    const r = serve();
    expect(await draft(pack, ids, "waiting")).toEqual([{ status: "skipped", reason: "pack_not_checked" }]);
    await withTransaction(db, (tx) =>
      forWorkspace(db, pack.ws).proofPacks.update(pack.packId, { state: "checked" }, tx),
    );
    expect(await draft(pack, ids, "open")).toEqual([{ status: "skipped", reason: "no_evidence_action" }]);
    expect(r.unmatched()).toEqual([]);
  });
});
