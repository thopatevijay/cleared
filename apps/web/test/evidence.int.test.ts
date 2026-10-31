// M2-01 integration: the evidence routes against the compose Postgres, with the synthetic files in
// fixtures/files/ and the M0 sample evidence in fixtures/samples/evidence/. Each AC has its own block.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  EvidenceAddedResponseSchema,
  EvidenceListResponseSchema,
  WorkspaceIdSchema,
  type PackState,
  type WorkspaceId,
} from "@cleared/core";
import { createPostgresBlobStore, evidenceSha256, prepareEvidenceFile } from "@cleared/adapters/files";
import { createPublisher, createQueue, forWorkspace, type Publisher } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { addEvidence } from "../src/server/evidence/intake.ts";
import { postDemo } from "../src/server/handlers/demo.ts";
import {
  getEvidenceFile,
  getEvidenceList,
  postEvidenceText,
  postEvidenceUpload,
} from "../src/server/handlers/evidence.ts";
import { getWorkspace } from "../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, ORIGIN, req, testDb, testDeps } from "./support/db.ts";
import { dbAvailable } from "./support/db-available.ts";

const FIXTURES = new URL("../../../fixtures/", import.meta.url);
const fixture = (path: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(new URL(path, FIXTURES)));

let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};
const created: string[] = [];
const q = async <T>(sql: string, params: unknown[]): Promise<T[]> =>
  (await testDb().$client.query(sql, params)).rows as T[];
const countIn = async (table: "evidence_items" | "blobs", wsId: string): Promise<number> =>
  Number(
    (await q<{ n: string }>(`select count(*)::text n from ${table} where workspace_id = $1`, [wsId]))[0]?.n,
  );
const outboxFor = (wsId: string) =>
  q<{ topic: string; version: number; payload: { data: Record<string, string> } }>(
    "select topic, version, payload from outbox where payload->>'workspaceId' = $1 order by created_at",
    [wsId],
  );

interface Seller {
  readonly cookie: string;
  readonly wsId: WorkspaceId;
  readonly packId: string;
}

async function seller(state: PackState = "empty"): Promise<Seller> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const wsId = WorkspaceIdSchema.parse(((await res.json()) as { workspace: { id: string } }).workspace.id);
  created.push(wsId);
  const repos = forWorkspace(testDb(), wsId);
  const payment = await repos.payments.insert({
    captureId: randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(),
    amount: "120.00",
    currency: "USD",
    status: "COMPLETED",
    source: "webhook",
  });
  const pack = await repos.proofPacks.insert({ paymentId: payment.id, state });
  return { cookie, wsId, packId: pack.id };
}

function uploadReq(
  s: Pick<Seller, "cookie">,
  packId: string,
  file: Uint8Array<ArrayBuffer> | null,
  opts: { kind?: string; name?: string; key?: string; type?: string } = {},
): Request {
  const form = new FormData();
  form.set("kind", opts.kind ?? "delivery");
  if (file !== null)
    form.set("file", new Blob([file], { type: opts.type ?? "image/png" }), opts.name ?? "f.png");
  return new Request(`${ORIGIN}/api/packs/${packId}/evidence/upload`, {
    method: "POST",
    headers: { origin: ORIGIN, "idempotency-key": opts.key ?? randomUUID(), cookie: s.cookie },
    body: form,
  });
}

const upload = (
  s: Seller,
  file: Uint8Array<ArrayBuffer> | null,
  opts: Parameters<typeof uploadReq>[3] = {},
  packId = s.packId,
) => postEvidenceUpload(uploadReq(s, packId, file, opts), testDeps(), publisher, packId);

const paste = (s: Seller, body: unknown, packId = s.packId, key?: string) =>
  postEvidenceText(
    req(`/api/packs/${packId}/evidence/text`, { cookie: s.cookie, body, ...(key ? { key } : {}) }),
    testDeps(),
    publisher,
    packId,
  );

const list = (s: Seller, packId = s.packId) =>
  getEvidenceList(
    req(`/api/packs/${packId}/evidence`, { method: "GET", cookie: s.cookie }),
    testDeps(),
    packId,
  );

const download = (s: Seller, id: string) =>
  getEvidenceFile(req(`/api/evidence/${id}/file`, { method: "GET", cookie: s.cookie }), testDeps(), id);

const item = async (res: Response) => {
  expect(res.status).toBe(201);
  return EvidenceAddedResponseSchema.parse(await res.json()).item;
};
const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe.skipIf(!dbAvailable)("evidence intake (integration)", () => {
  afterAll(async () => {
    // evidence.added jobs are real pg-boss rows in the shared test database; nothing consumes them yet.
    await testDb().$client.query(
      "delete from pgboss.job where name = 'evidence.added' and data->'data'->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("AC1: jpg/png/gif/pdf are stored once; the same bytes twice → two rows, one blob, same sha256", async () => {
    const s = await seller();
    const files = [
      ["files/photo-exif.jpg", "image/jpeg"],
      ["samples/evidence/screenshot-logo.png", "image/png"],
      ["files/animation.gif", "image/gif"],
      ["samples/evidence/delivery-note.pdf", "application/pdf"],
    ] as const;
    for (const [path, mime] of files) {
      const it = await item(await upload(s, fixture(path)));
      expect(it.mime).toBe(mime);
      expect(it.fileUrl).toBe(`/api/evidence/${it.id}/file`);
    }
    expect(await countIn("blobs", s.wsId)).toBe(4);

    const first = await item(
      await upload(s, fixture("samples/evidence/screenshot-logo.png"), { name: "again.png" }),
    );
    const rows = await q<{ id: string; blob_id: string; sha256: string }>(
      "select id, blob_id, sha256 from evidence_items where workspace_id = $1 and sha256 = $2",
      [s.wsId, first.sha256],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.blob_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.sha256)).size).toBe(1);
    expect(await countIn("blobs", s.wsId)).toBe(4);
    expect(await countIn("evidence_items", s.wsId)).toBe(5);
    // the sha256 is of the stored bytes
    const blob = await createPostgresBlobStore(testDb()).get(s.wsId, rows[0]?.blob_id ?? "");
    expect(evidenceSha256({ kind: "file", bytes: blob?.bytes ?? new Uint8Array() })).toBe(first.sha256);
  });

  it("AC2: HTML named .png, 10 MB + 1 byte, 31 pages, encrypted, 26 MP → typed codes; nothing written", async () => {
    const s = await seller();
    const tooBig = new Uint8Array(10_000_001);
    tooBig.set(fixture("files/screenshot-exif.png"));
    const cases: [Uint8Array<ArrayBuffer>, string, number][] = [
      [fixture("files/html-named.png"), "evidence_type", 415],
      [tooBig, "evidence_too_large", 413],
      [fixture("files/pages-31.pdf"), "evidence_too_many_pages", 422],
      [fixture("files/encrypted.pdf"), "evidence_encrypted", 422],
      [fixture("files/huge-26mp.png"), "evidence_too_many_pixels", 422],
    ];
    for (const [bytes, code, status] of cases) {
      const res = await upload(s, bytes, { name: "evidence.png", type: "image/png" });
      expect([res.status, await errorCode(res)]).toEqual([status, code]);
    }
    expect(await countIn("evidence_items", s.wsId)).toBe(0);
    expect(await countIn("blobs", s.wsId)).toBe(0);
    expect(await outboxFor(s.wsId)).toEqual([]);
  });

  it("AC3: a re-encoded image carries no EXIF (asserted on the stored bytes)", async () => {
    const s = await seller();
    const input = fixture("files/photo-exif.jpg");
    expect(Buffer.from(input).includes("Exif")).toBe(true);
    expect(Buffer.from(input).includes("Synthetic Seller")).toBe(true);
    const it = await item(await upload(s, input, { name: "photo.jpg", type: "image/jpeg" }));
    const [row] = await q<{ bytes: Buffer }>(
      "select b.bytes from blobs b join evidence_items e on e.blob_id = b.id where e.id = $1",
      [it.id],
    );
    const stored = row?.bytes ?? Buffer.alloc(0);
    expect(stored.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(stored.includes("Exif")).toBe(false);
    expect(stored.includes("Synthetic Seller")).toBe(false);
    expect(stored.includes("SyntheticCam")).toBe(false);
    expect(stored.includes(Buffer.from([0xff, 0xe1]))).toBe(false); // no APP1 (EXIF/XMP) segment
  });

  it("AC4: a text-layer PDF's text lands in evidence_items.text; pasted text hashes the same across CRLF/LF", async () => {
    const s = await seller();
    const pdf = await item(
      await upload(s, fixture("samples/evidence/delivery-logo.pdf"), { type: "application/pdf" }),
    );
    const [row] = await q<{ text: string | null }>("select text from evidence_items where id = $1", [pdf.id]);
    expect(row?.text).toContain("Northwind Tea Co.");
    expect(row?.text).toContain("HEX #1B7F79");
    expect(pdf.hasText).toBe(true);

    const chat = readFileSync(new URL("samples/evidence/chat-logo.txt", FIXTURES), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    const lf = await item(await paste(s, { kind: "communication", text: chat }));
    const crlf = await item(await paste(s, { kind: "communication", text: chat.replaceAll("\n", "\r\n") }));
    expect(crlf.sha256).toBe(lf.sha256);
    expect(lf.sha256).toBe(evidenceSha256({ kind: "text", text: chat }));
    expect(lf.mime).toBeNull();
    expect(lf.fileUrl).toBeNull();
    const [stored] = await q<{ text: string; blob_id: string | null }>(
      "select text, blob_id from evidence_items where id = $1",
      [crlf.id],
    );
    expect(stored).toEqual({ text: chat, blob_id: null });
  });

  it("AC5: no route updates or deletes evidence (only POST/GET exported); the database refuses it too", async () => {
    const modules = await Promise.all([
      import("../app/api/packs/[packId]/evidence/route.ts"),
      import("../app/api/packs/[packId]/evidence/upload/route.ts"),
      import("../app/api/packs/[packId]/evidence/text/route.ts"),
      import("../app/api/evidence/[id]/file/route.ts"),
    ]);
    for (const m of modules) {
      for (const verb of ["PUT", "PATCH", "DELETE"]) expect(verb in m).toBe(false);
    }
    await expect(testDb().$client.query("delete from evidence_items where false")).rejects.toMatchObject({
      code: "23001",
    });
  });

  it("AC6: another workspace's upload, paste, list or download → 404 and nothing is written", async () => {
    const a = await seller();
    const b = await seller();
    const own = await item(await upload(a, fixture("files/screenshot-exif.png")));
    const before = [await countIn("evidence_items", a.wsId), await countIn("blobs", a.wsId)];

    const asB = (packId: string) => ({ ...b, packId });
    const attempts = [
      await upload(asB(a.packId), fixture("files/screenshot-exif.png")),
      await paste(asB(a.packId), { kind: "communication", text: "injected" }),
      await list(b, a.packId),
      await download(b, own.id),
      await upload(b, fixture("files/screenshot-exif.png"), {}, randomUUID()),
      await list(b, "not-a-uuid"),
    ];
    for (const res of attempts) expect([res.status, await errorCode(res)]).toEqual([404, "not_found"]);

    expect([await countIn("evidence_items", a.wsId), await countIn("blobs", a.wsId)]).toEqual(before);
    expect([await countIn("evidence_items", b.wsId), await countIn("blobs", b.wsId)]).toEqual([0, 0]);
    expect(await outboxFor(b.wsId)).toEqual([]);
  });

  it("AC7: evidence on a checked pack → stale + evidence.added in one transaction; a mid-transaction failure leaves neither", async () => {
    const s = await seller("checked");
    const added = await item(await paste(s, { kind: "scope", text: "Scope: logo in SVG and PNG" }));
    const [pack] = await q<{ state: string }>("select state from proof_packs where id = $1", [s.packId]);
    expect(pack?.state).toBe("stale");
    const events = await outboxFor(s.wsId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: "evidence.added",
      version: 1,
      payload: { data: { packId: s.packId, evidenceItemId: added.id, kind: "scope", sha256: added.sha256 } },
    });
    const jobs = await q<{ id: string }>(
      "select id from pgboss.job where name = 'evidence.added' and data->'data'->'data'->>'evidenceItemId' = $1",
      [added.id],
    );
    expect(jobs).toHaveLength(1);

    // Kill the transaction after the blob and evidence rows are written (the outbox write throws).
    const t = await seller("checked");
    const prepared = await prepareEvidenceFile(fixture("files/screenshot-exif.png"));
    if (!prepared.ok) throw new Error(prepared.error.code);
    const dying = {
      db: testDb(),
      blobs: createPostgresBlobStore(testDb()),
      now: () => new Date(),
      publisher: {
        emit: async () => {
          const mid = await q<{ n: string }>(
            "select count(*)::text n from evidence_items where workspace_id = $1",
            [t.wsId],
          );
          expect(mid[0]?.n).toBe("0"); // not visible outside the transaction
          throw new Error("killed mid-transaction");
        },
      },
    };
    await expect(
      addEvidence(dying, t.wsId, t.packId, { type: "file", kind: "delivery", file: prepared.value }),
    ).rejects.toThrow("killed mid-transaction");
    const [still] = await q<{ state: string }>("select state from proof_packs where id = $1", [t.packId]);
    expect(still?.state).toBe("checked");
    expect(await countIn("evidence_items", t.wsId)).toBe(0);
    expect(await countIn("blobs", t.wsId)).toBe(0);
    expect(await outboxFor(t.wsId)).toEqual([]);
  });

  it("AC8: served files carry nosniff and attachment; a text item has no file", async () => {
    const s = await seller();
    const pdf = await item(await upload(s, fixture("files/text-layer.pdf"), { type: "application/pdf" }));
    const res = await download(s, pdf.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="evidence-[0-9a-f]{8}\.pdf"$/,
    );
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(evidenceSha256({ kind: "file", bytes: body })).toBe(pdf.sha256);

    const txt = await item(await paste(s, { kind: "communication", text: "Buyer: thanks!" }));
    expect((await download(s, txt.id)).status).toBe(404);
    expect((await download(s, "not-a-uuid")).status).toBe(404);
  });

  it("lists newest first; validates kind, content type and the single file; replays an Idempotency-Key", async () => {
    const s = await seller();
    const one = await item(await paste(s, { kind: "scope", text: "first" }));
    const two = await item(await upload(s, fixture("files/animation.gif"), { type: "image/gif" }));
    const listed = EvidenceListResponseSchema.parse(await (await list(s)).json());
    expect(listed.items.map((i) => i.id)).toEqual([two.id, one.id]);
    expect(listed.items[1]).toMatchObject({ excerpt: "first", textLength: 5, hasText: true });

    expect((await upload(s, fixture("files/animation.gif"), { kind: "client_ack" })).status).toBe(400);
    expect((await paste(s, { kind: "scope_snapshot", text: "x" })).status).toBe(400);
    expect((await upload(s, null)).status).toBe(400);
    const empty = await paste(s, { kind: "scope", text: " \r\n " });
    expect([empty.status, await errorCode(empty)]).toEqual([422, "evidence_text_empty"]);
    const long = await paste(s, { kind: "scope", text: "a".repeat(50_001) });
    expect([long.status, await errorCode(long)]).toEqual([413, "evidence_text_too_long"]);
    const jsonUpload = postEvidenceUpload(
      req(`/api/packs/${s.packId}/evidence/upload`, { cookie: s.cookie, body: {} }),
      testDeps(),
      publisher,
      s.packId,
    );
    expect((await jsonUpload).status).toBe(415);
    const anon = await postEvidenceText(
      req(`/api/packs/${s.packId}/evidence/text`, { body: { kind: "scope", text: "x" } }),
      testDeps(),
      publisher,
      s.packId,
    );
    expect(anon.status).toBe(401);

    const key = randomUUID();
    const a = await paste(s, { kind: "scope", text: "once" }, s.packId, key);
    const b = await paste(s, { kind: "scope", text: "once" }, s.packId, key);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    expect((await item(b)).id).toBe((await item(a)).id);
    expect(await countIn("evidence_items", s.wsId)).toBe(3);
  });

  it("caps: 50 items per pack", async () => {
    const s = await seller();
    for (let i = 0; i < 50; i++)
      await item(await paste(s, { kind: "communication", text: `message ${String(i)}` }));
    const full = await paste(s, { kind: "communication", text: "one too many" });
    expect([full.status, await errorCode(full)]).toEqual([409, "evidence_pack_full"]);
    expect(await countIn("evidence_items", s.wsId)).toBe(50);
  });
});
