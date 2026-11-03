// M3-07 integration: GET/POST /api/packs/:packId/scope-snapshot against the compose Postgres. The snapshot is
// a download scoped to the session's workspace (AC 6: another workspace gets a 404), and POST queues the
// worker's `scope_snapshot.render` job in the request's transaction.
import { randomUUID } from "node:crypto";
import {
  createPostgresBlobStore,
  evidenceSha256,
  renderScopeSnapshotPdf,
  writeEvidence,
} from "@cleared/adapters/files";
import { Sha256Schema, WorkspaceIdSchema, type WorkspaceId } from "@cleared/core";
import { createPublisher, createQueue, forWorkspace, withTransaction, type Publisher } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { postDemo } from "../src/server/handlers/demo.ts";
import { getScopeSnapshot, postScopeSnapshot } from "../src/server/handlers/scope-snapshot.ts";
import { getWorkspace } from "../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "./support/db.ts";
import { dbAvailable } from "./support/db-available.ts";

let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};
const created: string[] = [];
const SCOPE = "Logo in SVG and PNG, three colour variants, two revision rounds.";

interface Seller {
  readonly cookie: string;
  readonly wsId: WorkspaceId;
  readonly packId: string;
}

async function seller(scope: string | null = SCOPE): Promise<Seller> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const wsId = WorkspaceIdSchema.parse(((await res.json()) as { workspace: { id: string } }).workspace.id);
  created.push(wsId);
  const r = forWorkspace(testDb(), wsId);
  const payment = await r.payments.insert({
    captureId: randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(),
    amount: "240.00",
    currency: "USD",
    status: "COMPLETED",
    source: "webhook",
  });
  const pack = await r.proofPacks.insert({ paymentId: payment.id, state: "checked" });
  if (scope !== null)
    await r.evidenceItems.insert({
      packId: pack.id,
      kind: "scope",
      sha256: evidenceSha256({ kind: "text", text: scope }),
      text: scope,
    });
  return { cookie, wsId, packId: pack.id };
}

/** Stores a rendered snapshot the way the worker job does (blob + item + outbox, one transaction). */
async function storeSnapshot(s: Seller): Promise<{ sha256: string; bytes: Uint8Array }> {
  const pdf = await renderScopeSnapshotPdf({
    packId: s.packId,
    payment: {
      captureId: "7HX48211LM305624B",
      amount: "240.00",
      currency: "USD",
      date: "2026-10-02T11:20:00.000Z",
    },
    scope: { itemId: randomUUID(), sha256: evidenceSha256({ kind: "text", text: SCOPE }), text: SCOPE },
    delivery: [],
    ack: null,
    timeZone: "UTC",
    locale: "en",
    generatedAt: "2026-11-02T06:00:00.000Z",
  });
  const sha256 = Sha256Schema.parse(pdf.sha256);
  const deps = {
    db: testDb(),
    blobs: createPostgresBlobStore(testDb()),
    publisher: await publisher(),
    now: () => new Date(),
  };
  await withTransaction(testDb(), (tx) =>
    writeEvidence(deps, tx, s.wsId, s.packId, {
      type: "file",
      kind: "scope_snapshot",
      file: { mime: "application/pdf", bytes: pdf.bytes, size: pdf.size, sha256, text: null },
      inputSha256: sha256,
    }),
  );
  return { sha256: pdf.sha256, bytes: pdf.bytes };
}

const download = (s: Seller, packId = s.packId) =>
  getScopeSnapshot(
    req(`/api/packs/${packId}/scope-snapshot`, { method: "GET", cookie: s.cookie }),
    testDeps(),
    packId,
  );

const create = (s: Seller, opts: { origin?: string | null; packId?: string } = {}) => {
  const packId = opts.packId ?? s.packId;
  return postScopeSnapshot(
    req(`/api/packs/${packId}/scope-snapshot`, {
      cookie: s.cookie,
      body: {},
      ...(opts.origin === undefined ? {} : { origin: opts.origin }),
    }),
    testDeps(),
    packId,
    publisher,
  );
};

const renderJobs = async (packId: string): Promise<number> =>
  Number(
    (
      await testDb().$client.query<{ n: string }>(
        "select count(*)::text as n from pgboss.job where name = 'scope_snapshot.render' and data->'data'->>'packId' = $1",
        [packId],
      )
    ).rows[0]?.n ?? -1,
  );

describe.skipIf(!dbAvailable)("scope snapshot routes (M3-07, integration)", () => {
  afterAll(async () => {
    await testDb().$client.query(
      "delete from pgboss.job where (name = 'scope_snapshot.render' and data->>'workspaceId' = any($1)) or (name = 'evidence.added' and data->'data'->>'workspaceId' = any($1))",
      [created],
    );
  });

  it("GET downloads the newest snapshot as a PDF attachment of its own workspace", async () => {
    const s = await seller();
    const { sha256, bytes } = await storeSnapshot(s);
    const res = await download(s);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="scope-snapshot-${sha256.slice(0, 12)}.pdf"`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  it("AC6: downloading from another workspace returns 404 (same as an unknown pack)", async () => {
    const owner = await seller();
    await storeSnapshot(owner);
    const other = await seller();
    const res = await download(other, owner.packId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect((await download(other, randomUUID())).status).toBe(404);
    expect((await download(other, "not-a-uuid")).status).toBe(404);
  });

  it("GET without a snapshot yet is a 404; without a session it is a 401", async () => {
    const s = await seller();
    expect((await download(s)).status).toBe(404);
    const anon = await getScopeSnapshot(
      req(`/api/packs/${s.packId}/scope-snapshot`, { method: "GET" }),
      testDeps(),
      s.packId,
    );
    expect(anon.status).toBe(401);
  });

  it("POST queues one scope_snapshot.render job for the pack (202)", async () => {
    const s = await seller();
    const res = await create(s);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(await renderJobs(s.packId)).toBe(1);
  });

  it("POST refuses a pack without scope (409), a foreign pack (404) and a cross-site request (403), queueing nothing", async () => {
    const empty = await seller(null);
    const r409 = await create(empty);
    expect(r409.status).toBe(409);
    expect(((await r409.json()) as { error: { code: string } }).error.code).toBe("snapshot_no_scope");
    const owner = await seller();
    const other = await seller();
    expect((await create(other, { packId: owner.packId })).status).toBe(404);
    expect((await create(owner, { origin: "https://evil.example" })).status).toBe(403);
    expect(await renderJobs(owner.packId)).toBe(0);
    expect(await renderJobs(empty.packId)).toBe(0);
  });
});
