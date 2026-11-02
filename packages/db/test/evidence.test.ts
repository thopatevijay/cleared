// M2-01: the evidence repository is insert + read only, scoped to one workspace, and its pack lock and
// content-addressed blob lookup behave as the intake transaction expects.
import { randomUUID } from "node:crypto";
import { WorkspaceIdSchema } from "@cleared/core";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { evidenceRepo } from "../src/repos/workspace/evidence.ts";
import type { WorkspaceRepos } from "../src/repos/workspace/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { newWorkspace, paypalId, sha } from "./graph.ts";

const MUTATORS = /^(update|upsert|delete|remove|set|patch|purge|truncate)/i;

async function packIn(r: WorkspaceRepos) {
  const payment = await r.payments.insert({
    captureId: paypalId(),
    amount: "42.00",
    currency: "USD",
    status: "COMPLETED",
    source: "webhook",
  });
  return r.proofPacks.insert({ paymentId: payment.id });
}

describe("evidence repository surface", () => {
  it("exposes no update or delete for evidence items (append-only)", () => {
    const repo = evidenceRepo({} as never, WorkspaceIdSchema.parse(randomUUID()));
    expect(Object.keys(repo.items).sort()).toEqual([
      "countForPack",
      "get",
      "insert",
      "listForPack",
      "snapshotForInput", // M3-07: a read (the snapshot job's idempotency lookup)
      "usageBytes",
    ]);
    expect(Object.keys(repo.items).filter((k) => MUTATORS.test(k))).toEqual([]);
    expect(Object.keys(repo.blobs).filter((k) => MUTATORS.test(k))).toEqual([]);
  });

  it("throws on a non-uuid workspace id", () => {
    expect(() => evidenceRepo({} as never, "nope" as never)).toThrow();
  });
});

describe.skipIf(!dbAvailable)("evidence repository (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  afterAll(() => closeDb(db));

  it("inserts and reads items and blobs inside one workspace only", async () => {
    const a = await newWorkspace(db);
    const b = await newWorkspace(db);
    const pack = await packIn(a);
    const ea = evidenceRepo(db, a.workspaceId);
    const eb = evidenceRepo(db, b.workspaceId);
    const bytes = Buffer.from("%PDF-1.7 synthetic");
    const digest = sha("synthetic-pdf");

    const item = await withTransaction(db, async (tx) => {
      await ea.blobs.lockSha256(digest, tx);
      expect(await ea.blobs.findBySha256(digest, tx)).toBeNull();
      const blob = await ea.blobs.insert(
        { mime: "application/pdf", bytes, size: bytes.length, sha256: digest },
        tx,
      );
      expect(await ea.packs.lock(pack.id, tx)).toMatchObject({ id: pack.id, state: "empty" });
      await ea.packs.setState(pack.id, "collecting", tx);
      return ea.items.insert(
        { packId: pack.id, kind: "delivery", blobId: blob.id, sha256: digest, text: "t" },
        tx,
      );
    });

    expect(await ea.items.get(item.id)).toMatchObject({ id: item.id, sha256: digest });
    expect((await ea.blobs.findBySha256(digest))?.size).toBe(bytes.length);
    const listed = await ea.items.listForPack(pack.id);
    expect(listed.map((r) => [r.id, r.mime, r.size])).toEqual([[item.id, "application/pdf", bytes.length]]);
    expect(await ea.items.countForPack(pack.id)).toBe(1);
    expect(await ea.items.usageBytes()).toBe(bytes.length);
    expect((await ea.packs.getOwned(pack.id))?.state).toBe("collecting");

    // workspace B sees none of it
    expect(await eb.items.get(item.id)).toBeNull();
    expect(await eb.blobs.get(item.blobId ?? "")).toBeNull();
    expect(await eb.blobs.findBySha256(digest)).toBeNull();
    expect(await eb.items.listForPack(pack.id)).toEqual([]);
    expect(await eb.packs.getOwned(pack.id)).toBeNull();
    expect(await withTransaction(db, (tx) => eb.packs.lock(pack.id, tx))).toBeNull();
    // malformed ids answer null / [] instead of a cast error
    expect(await ea.items.get("x")).toBeNull();
    expect(await ea.items.listForPack("x")).toEqual([]);
    expect(await ea.packs.getOwned("x")).toBeNull();
  });

  it("text-only items count their UTF-8 bytes toward the workspace usage", async () => {
    const a = await newWorkspace(db);
    const pack = await packIn(a);
    const ea = evidenceRepo(db, a.workspaceId);
    await withTransaction(db, (tx) =>
      ea.items.insert(
        { packId: pack.id, kind: "communication", blobId: null, sha256: sha("é"), text: "é" },
        tx,
      ),
    );
    expect(await ea.items.usageBytes()).toBe(2);
  });

  it("the database refuses an update or delete of an evidence item (trigger, SQLSTATE 23001)", async () => {
    await expect(db.$client.query("update evidence_items set text = 'x' where false")).rejects.toMatchObject({
      code: "23001",
    });
    await expect(db.$client.query("delete from evidence_items where false")).rejects.toMatchObject({
      code: "23001",
    });
  });
});
