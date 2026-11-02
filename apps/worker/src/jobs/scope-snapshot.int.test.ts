// M3-07 on the compose Postgres: the `scope_snapshot.render` job stores the PDF (blob + immutable
// `scope_snapshot` item + `evidence.added` outbox row) in one transaction (AC 7), is idempotent on
// (pack, input hash), embeds only the acknowledgement of the current scope item, and a `client_ack` arriving
// refreshes it. BL-01 6569233018 (ADR 0018): Cleared's records run no AI and settle a stale pack.
import { randomUUID } from "node:crypto";
import {
  createPostgresBlobStore,
  evidenceSha256,
  extractPdfText,
  writeEvidence,
} from "@cleared/adapters/files";
import {
  CHECK_SCOPE_PROMPT,
  clientAckEvidence,
  parseAgentConfig,
  type AiProvider,
  type SellerEvidenceKind,
  type WorkspaceId,
} from "@cleared/core";
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
import { newPack, newWorkspace, silentLog } from "../../test/extract-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { evidenceSetHashOf } from "./check-scope.ts";
import { extractEvidence } from "./extract-evidence.ts";
import { renderScopeSnapshot, snapshotOnAckHandler, type SnapshotOutcome } from "./render-scope-snapshot.ts";

const db = createDb(url);
let boss: Queue;
const workspaces: string[] = [];
const NOW = new Date("2026-11-02T06:00:00.000Z");
const deps = () => ({ db, publisher: createPublisher(db, boss), now: () => NOW });
const envelope = () => ({ messageId: randomUUID(), correlationId: randomUUID(), data: null });

async function workspace(): Promise<WorkspaceId> {
  const ws = await newWorkspace(db);
  workspaces.push(ws);
  return ws;
}

async function addText(ws: WorkspaceId, packId: string, kind: SellerEvidenceKind, text: string) {
  const sha256 = evidenceSha256({ kind: "text", text });
  return withTransaction(db, (tx) =>
    writeEvidence(
      { db, blobs: createPostgresBlobStore(db), publisher: createPublisher(db, boss), now: () => NOW },
      tx,
      ws,
      packId,
      { type: "text", kind, text, sha256 },
    ),
  );
}

async function ack(ws: WorkspaceId, packId: string, scopeSha256: string) {
  const record = {
    scopeSha256,
    typedName: "Lena Okafor",
    acceptedAt: new Date("2026-10-05T09:30:12Z"),
    ip: "203.0.113.24",
    userAgent: "Mozilla/5.0 test",
  };
  const { text, sha256 } = clientAckEvidence(record);
  return withTransaction(db, (tx) =>
    writeEvidence(
      { db, blobs: createPostgresBlobStore(db), publisher: createPublisher(db, boss), now: () => NOW },
      tx,
      ws,
      packId,
      { type: "text", kind: "client_ack", text, sha256 },
    ),
  );
}

const render = (ws: WorkspaceId, packId: string): Promise<SnapshotOutcome> =>
  withTransaction(db, (tx) => renderScopeSnapshot(deps(), ws, packId, { tx, log: silentLog }));

async function snapshots(packId: string) {
  const r = await db.$client.query<{ id: string; sha256: string; blob_id: string; input_sha256: string }>(
    "select id, sha256, blob_id, input_sha256 from evidence_items where pack_id = $1 and kind = 'scope_snapshot' order by created_at",
    [packId],
  );
  return r.rows;
}

async function outboxFor(itemId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text as n from outbox where topic = 'evidence.added' and payload->'data'->>'evidenceItemId' = $1",
    [itemId],
  );
  return Number(r.rows[0]?.n ?? -1);
}

async function pdfText(ws: WorkspaceId, blobId: string): Promise<string> {
  const blob = await createPostgresBlobStore(db).get(ws, blobId);
  if (blob === null) throw new Error("no blob");
  expect(blob.mime).toBe("application/pdf");
  return (await extractPdfText(blob.bytes)) ?? "";
}

async function packWithScope() {
  const ws = await workspace();
  const packId = await newPack(db, ws);
  const scope = await addText(ws, packId, "scope", "Logo in SVG and PNG; two revision rounds.");
  await addText(ws, packId, "delivery", "Delivered the final files on 19 October.");
  return { ws, packId, scope };
}

describe.skipIf(!dbAvailable)("scope_snapshot.render (M3-07, compose Postgres)", () => {
  beforeAll(async () => {
    boss = await createQueue(db);
  });
  afterAll(async () => {
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [workspaces]);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("writes a PDF blob, an immutable scope_snapshot item and its evidence.added outbox row", async () => {
    const { ws, packId, scope } = await packWithScope();
    const out = await render(ws, packId);
    if (out.status !== "written") throw new Error(out.status);
    const [row, ...rest] = await snapshots(packId);
    expect(rest).toEqual([]);
    expect(row?.id).toBe(out.itemId);
    expect(row?.sha256).toBe(out.sha256);
    expect(row?.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.size).toBeLessThan(10_000_000);
    expect(await outboxFor(out.itemId)).toBe(1);
    const text = await pdfText(ws, row?.blob_id ?? "");
    expect(text).toContain("Logo in SVG and PNG; two revision rounds.");
    expect(text).toContain(scope.sha256);
    expect(text).toContain("Not acknowledged by the client");
  });

  it("is idempotent on (pack, input hash): a second run with nothing new writes nothing", async () => {
    const { ws, packId } = await packWithScope();
    const first = await render(ws, packId);
    const again = await render(ws, packId);
    if (first.status !== "written") throw new Error(first.status);
    expect(again).toEqual({ status: "exists", itemId: first.itemId });
    expect(await snapshots(packId)).toHaveLength(1);
  });

  it("AC7: the item and the outbox row are written in one transaction (a forced failure leaves neither)", async () => {
    const { ws, packId } = await packWithScope();
    const before = await db.$client.query<{ n: string }>(
      "select count(*)::text as n from outbox where payload->>'workspaceId' = $1",
      [ws],
    );
    await expect(
      withTransaction(db, async (tx) => {
        const out = await renderScopeSnapshot(deps(), ws, packId, { tx, log: silentLog });
        expect(out.status).toBe("written");
        throw new Error("forced failure after the write");
      }),
    ).rejects.toThrow("forced failure");
    expect(await snapshots(packId)).toEqual([]);
    const after = await db.$client.query<{ n: string }>(
      "select count(*)::text as n from outbox where payload->>'workspaceId' = $1",
      [ws],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await render(ws, packId)).status).toBe("written"); // and the job can then succeed
  });

  it("a client_ack of the current scope refreshes the snapshot with the acknowledgement block", async () => {
    const { ws, packId, scope } = await packWithScope();
    await render(ws, packId);
    const item = await ack(ws, packId, scope.sha256);
    const event = {
      type: "evidence.added",
      version: 1,
      workspaceId: ws,
      occurredAt: NOW.toISOString(),
      data: { packId, evidenceItemId: item.id, kind: "client_ack", sha256: item.sha256 },
    };
    await withTransaction(db, (tx) =>
      snapshotOnAckHandler(deps())(event, { tx, log: silentLog, envelope: envelope(), job: {} as never }),
    );
    const rows = await snapshots(packId);
    expect(rows).toHaveLength(2);
    const text = await pdfText(ws, rows[1]?.blob_id ?? "");
    expect(text).toContain("Accepted at: 2026-10-05T09:30:12.000Z (UTC)");
    expect(text).toContain(`Acknowledgement record sha256: ${item.sha256}`);
    expect(text).not.toContain("Not acknowledged by the client");
  });

  it("an acknowledgement of an earlier scope does not count; a pack without scope or another workspace's pack writes nothing", async () => {
    const { ws, packId, scope } = await packWithScope();
    await ack(ws, packId, scope.sha256);
    await addText(ws, packId, "scope", "Revised: logo in SVG only.");
    const out = await render(ws, packId);
    if (out.status !== "written") throw new Error(out.status);
    const text = await pdfText(ws, (await snapshots(packId))[0]?.blob_id ?? "");
    expect(text).toContain("Revised: logo in SVG only.");
    expect(text).toContain("Not acknowledged by the client");

    const empty = await newPack(db, ws);
    expect(await render(ws, empty)).toEqual({ status: "no_scope" });
    expect(await render(await workspace(), packId)).toEqual({ status: "not_found" });
  });

  it("BL-01 6569233018: a client_ack runs no AI and puts a pack whose check still covers its evidence back to checked", async () => {
    const { ws, packId, scope } = await packWithScope();
    const items = await evidenceRepo(db, ws).items.listForPack(packId);
    // the two seller items finished extraction and a check covers exactly them
    for (const i of items)
      await forWorkspace(db, ws).auditLog.insert({
        actor: "system",
        action: "extract.no_facts",
        detail: { evidenceItemId: i.id, status: "degraded" },
      });
    await withTransaction(db, async (tx) => {
      const hash = (await evidenceSetHashOf(db, ws, packId, tx)) ?? "";
      const line = {
        lineId: "L1",
        line: "Logo in SVG and PNG",
        verdict: "unverifiable",
        modelVerdict: "unverifiable",
        note: null,
        rationale: "test",
        lineCitation: null,
        citations: [],
      } as const;
      await scopeChecksRepo(db, ws).insertCheck(
        { packId, evidenceSetHash: hash, promptVersion: CHECK_SCOPE_PROMPT.id, runId: null, lines: [line] },
        tx,
      );
      await evidenceRepo(db, ws).packs.setState(packId, "checked", tx);
    });
    const item = await ack(ws, packId, scope.sha256);
    expect((await evidenceRepo(db, ws).packs.getOwned(packId))?.state).toBe("stale"); // M3-06 AC 6 holds
    const noAi: AiProvider = {
      complete: () => Promise.reject(new Error("the AI must not run")),
    } as unknown as AiProvider;
    const event = {
      type: "evidence.added" as const,
      version: 1 as const,
      workspaceId: ws,
      occurredAt: NOW.toISOString() as never,
      data: {
        packId: packId as never,
        evidenceItemId: item.id as never,
        kind: "client_ack" as const,
        sha256: item.sha256 as never,
      },
    };
    const out = await withTransaction(db, (tx) =>
      extractEvidence(
        {
          db,
          publisher: createPublisher(db, boss),
          provider: noAi,
          config: parseAgentConfig({}),
          now: () => NOW,
        },
        event,
        { tx, log: silentLog, envelope: envelope() },
      ),
    );
    expect(out).toEqual({ status: "record", pack: "restored" });
    expect((await evidenceRepo(db, ws).packs.getOwned(packId))?.state).toBe("checked");
    const runs = await db.$client.query<{ n: string }>(
      "select count(*)::text as n from agent_runs where workspace_id = $1",
      [ws],
    );
    expect(runs.rows[0]?.n).toBe("0");
    expect(await scopeChecksRepo(db, ws).itemsAwaitingFacts(packId, "extract@v1")).toEqual([]);
  });
});
