// M2-01: the Postgres BlobStore is content-addressed per workspace (identical bytes → one row, even under
// concurrent writers), scoped (another workspace reads null) and transactional (a rollback leaves nothing).
// Runs against the compose Postgres (DATABASE_URL); skips when unreachable, FAILS under REQUIRE_DB=1 (CI).
import { randomUUID } from "node:crypto";
import { WorkspaceIdSchema, type WorkspaceId } from "@cleared/core";
import { closeDb, createDb, databaseUrl, platform, withTransaction, type Db } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Of } from "../files/hash.ts";
import { createPostgresBlobStore } from "./postgres-blob-store.ts";

async function reachable(db: Db): Promise<boolean> {
  try {
    await db.$client.query("select 1 from blobs limit 1");
    return true;
  } catch {
    return false;
  }
}

const db = createDb(databaseUrl());
db.$client.on("error", () => undefined);
const dbAvailable = await reachable(db);
if (!dbAvailable && process.env["REQUIRE_DB"] === "1") {
  throw new Error(`Postgres unreachable at ${new URL(databaseUrl()).host} and REQUIRE_DB=1`);
}

async function workspace(): Promise<WorkspaceId> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  return WorkspaceIdSchema.parse(ws.id);
}

const countBlobs = async (ws: string): Promise<number> => {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text n from blobs where workspace_id = $1",
    [ws],
  );
  return Number(r.rows[0]?.n);
};

afterAll(() => closeDb(db));

describe.skipIf(!dbAvailable)("Postgres BlobStore", () => {
  const store = createPostgresBlobStore(db);
  const bytes = new TextEncoder().encode(`synthetic blob ${randomUUID()}`);

  it("stores bytes once per workspace and reuses the row for identical bytes", async () => {
    const ws = await workspace();
    const first = await withTransaction(db, (tx) =>
      store.put({ workspaceId: ws, bytes, mime: "image/png" }, tx),
    );
    const second = await withTransaction(db, (tx) =>
      store.put({ workspaceId: ws, bytes, mime: "image/png" }, tx),
    );
    expect(first.reused).toBe(false);
    expect(second).toEqual({ ...first, reused: true });
    expect(first.sha256).toBe(sha256Of(bytes));
    expect(await countBlobs(ws)).toBe(1);

    const got = await store.get(ws, first.id);
    expect(got?.mime).toBe("image/png");
    expect(Buffer.from(got?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  it("concurrent puts of the same bytes still share one row (advisory lock)", async () => {
    const ws = await workspace();
    const same = new TextEncoder().encode(`race ${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction(db, (tx) => store.put({ workspaceId: ws, bytes: same, mime: "application/pdf" }, tx)),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await countBlobs(ws)).toBe(1);
  });

  it("another workspace gets its own row and cannot read the first one's", async () => {
    const a = await workspace();
    const b = await workspace();
    const inA = await withTransaction(db, (tx) =>
      store.put({ workspaceId: a, bytes, mime: "image/gif" }, tx),
    );
    const inB = await withTransaction(db, (tx) =>
      store.put({ workspaceId: b, bytes, mime: "image/gif" }, tx),
    );
    expect(inB.id).not.toBe(inA.id);
    expect(inB.reused).toBe(false);
    expect(await store.get(b, inA.id)).toBeNull();
    expect(await store.get(a, "not-a-uuid")).toBeNull();
  });

  it("a rolled-back transaction leaves no blob", async () => {
    const ws = await workspace();
    await expect(
      withTransaction(db, async (tx) => {
        await store.put({ workspaceId: ws, bytes, mime: "image/png" }, tx);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await countBlobs(ws)).toBe(0);
  });
});
