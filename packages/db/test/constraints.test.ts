// AC: append-only triggers, webhook dedupe on (provider, event_id), and rollback through `tx`.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { platform } from "../src/repos/platform/index.ts";
import type { WorkspaceRepos } from "../src/repos/workspace/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { newWorkspace, paypalId, seedGraph } from "./graph.ts";

class Rollback extends Error {}

describe.skipIf(!dbAvailable)("constraints (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  let ws: WorkspaceRepos;
  let ids: Awaited<ReturnType<typeof seedGraph>>;

  beforeAll(async () => {
    ws = await newWorkspace(db);
    ids = await seedGraph(ws);
  });
  afterAll(() => closeDb(db));

  it.each([
    ["UPDATE audit_log", "update audit_log set action = 'x'", "audit_log is append-only: UPDATE"],
    ["DELETE FROM audit_log", "delete from audit_log", "audit_log is append-only: DELETE"],
    [
      "UPDATE evidence_items",
      "update evidence_items set text = 'x'",
      "evidence_items is append-only: UPDATE",
    ],
    ["DELETE FROM evidence_items", "delete from evidence_items", "evidence_items is append-only: DELETE"],
    ["TRUNCATE audit_log", "truncate audit_log", "audit_log is append-only: TRUNCATE"],
    // M2-04: a scope check is a version; new evidence writes the next one and never edits an old row
    ["UPDATE scope_checks", "update scope_checks set verdict = 'met'", "scope_checks is append-only: UPDATE"],
    ["DELETE FROM scope_checks", "delete from scope_checks", "scope_checks is append-only: DELETE"],
  ])("%s fails with the trigger's error", async (_label, statement, message) => {
    await expect(db.$client.query(statement)).rejects.toThrow(message);
  });

  it("the trigger fires even when no row matches", async () => {
    await expect(
      db.$client.query("delete from evidence_items where id = $1", [randomUUID()]),
    ).rejects.toThrow("append-only");
  });

  it("the audit row and the evidence row are still there", async () => {
    expect(await ws.auditLog.get(ids.auditLog ?? "")).not.toBeNull();
    expect(await ws.evidenceItems.get(ids.evidenceItems ?? "")).not.toBeNull();
  });

  it("a duplicate (provider, event_id) with ON CONFLICT DO NOTHING returns zero rows", async () => {
    const event = {
      provider: "paypal",
      eventId: `WH-${paypalId()}`,
      type: "PAYMENT.CAPTURE.COMPLETED",
      raw: {},
    };
    const first = await platform(db).webhookEvents.insertRaw(event);
    expect(first?.status).toBe("received");
    expect(await platform(db).webhookEvents.insertRaw(event)).toBeNull();
    const raw = await db.$client.query(
      "insert into webhook_events (provider, event_id, type, raw) values ($1, $2, $3, '{}') on conflict do nothing returning id",
      [event.provider, event.eventId, event.type],
    );
    expect(raw.rowCount).toBe(0);
  });

  it("a rolled-back transaction passed through tx leaves no rows", async () => {
    const captureId = paypalId();
    const topic = `test.rollback.${randomUUID()}`;
    await expect(
      withTransaction(db, async (tx) => {
        const p = await ws.payments.insert(
          { captureId, amount: "10.00", currency: "USD", status: "COMPLETED", source: "poll" },
          tx,
        );
        await ws.auditLog.insert({ actor: "system", action: "payment.captured", detail: { id: p.id } }, tx);
        await platform(db).outbox.append({ topic, version: 1, payload: { captureId } }, tx);
        expect(await ws.payments.getByCaptureId(captureId, tx)).not.toBeNull();
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await ws.payments.getByCaptureId(captureId)).toBeNull();
    const outbox = await db.$client.query("select 1 from outbox where topic = $1", [topic]);
    expect(outbox.rowCount).toBe(0);
  });

  it("a committed transaction keeps its rows", async () => {
    const captureId = paypalId();
    await withTransaction(db, (tx) =>
      ws.payments.insert(
        { captureId, amount: "10.00", currency: "USD", status: "COMPLETED", source: "poll" },
        tx,
      ),
    );
    expect(await ws.payments.getByCaptureId(captureId)).not.toBeNull();
  });

  it("dispute draft notes are capped at 2000 characters", async () => {
    await expect(
      ws.disputeDrafts.insert({ disputeId: ids.disputes ?? "", notes: "x".repeat(2001) }),
    ).rejects.toThrow();
  });

  it("platform helpers: owner claim keeps the first owner; consumer receipts dedupe; heartbeats upsert", async () => {
    const p = platform(db);
    const other = await newWorkspace(db);
    const resourceId = paypalId();
    const first = await p.resourceOwners.claim({
      resourceType: "capture",
      resourceId,
      workspaceId: ws.workspaceId,
    });
    const second = await p.resourceOwners.claim({
      resourceType: "capture",
      resourceId,
      workspaceId: other.workspaceId,
    });
    expect(second.workspaceId).toBe(first.workspaceId);
    const msg = randomUUID();
    expect(await p.consumerReceipts.record("test", msg)).toBe(true);
    expect(await p.consumerReceipts.record("test", msg)).toBe(false);
    const worker = `test-${randomUUID()}`;
    await p.workerHeartbeats.beat(worker, new Date(1_000));
    await p.workerHeartbeats.beat(worker, new Date(2_000));
    expect((await p.workerHeartbeats.get(worker))?.beatAt.getTime()).toBe(2_000);
  });
});
