// `action.execute` over the recorded M0-05 dispute exchanges (M2-08 AC): the 200 and 422 replays, every
// refusal with no PayPal write, timeout → unknown, at-most-once on redelivery, and the audit sequence.
import {
  actionAuditTrail,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  executionForAction,
  getProposedAction,
  platform,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvedAction,
  BASE,
  ctxFor,
  disputesWithHttp,
  evidencePayload,
  NOW,
  PDF_SHA,
  recordCalls,
  sceneWithDispute,
  serveDispute,
  serveWrite,
  writes,
  type PayPalCall,
} from "../../test/actions-support.ts";
import { STATE } from "../../test/disputes-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { executeAction, type ExecuteActionDeps, type ExecuteOutcome } from "./execute-action.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
let calls: PayPalCall[];
const created: string[] = [];
const EVIDENCE_OK = "paypal/disputes/full/write-evidence.2";
const EVIDENCE_422 = "paypal/disputes/errors/provide-evidence-not-allowed";

function deps(over: Partial<ExecuteActionDeps> = {}) {
  const { http, disputes } = disputesWithHttp(server);
  const d: ExecuteActionDeps = { db, publisher, disputes, now: () => NOW, killSwitchEnv: () => false, writeTimeoutMs: 1_500, ...over };
  return { d, http };
}

const execute = (d: ExecuteActionDeps, actionId: string, ws: string): Promise<ExecuteOutcome> =>
  withTransaction(db, (tx) => executeAction(d, { actionId, workspaceId: ws }, ctxFor(tx, { actionId })));

async function evidenceScene() {
  const s = await sceneWithDispute(db, created);
  const actionId = await approvedAction(db, publisher, s, "provide_evidence", evidencePayload(s.ids, s.draftId));
  return { ...s, actionId };
}

/** Lets the delayed (timed-out) msw response finish, so it cannot reset the next test's connection. */
const settleLateResponse = (): Promise<void> => new Promise((r) => setTimeout(r, 1_500));

async function stateOf(ws: string, id: string) {
  const row = await getProposedAction(db, ws, id);
  return { state: row?.state, code: row?.refusalCode ?? null };
}

async function jobs(queue: string, actionId: string) {
  const r = await db.$client.query<{ data: { data: Record<string, unknown> }; start_after: Date }>(
    "select data, start_after from pgboss.job where name = $1 and data->'data'->>'actionId' = $2",
    [queue, actionId],
  );
  return r.rows;
}

describe.skipIf(!dbAvailable)("action.execute (execute-action)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  beforeEach(() => {
    calls = recordCalls(server);
  });
  afterEach(() => {
    server.events.removeAllListeners();
    server.resetHandlers();
  });
  afterAll(async () => {
    server.close();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
    await platform(db).flags.setAgentKillSwitch(false);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("replays provide_evidence 200: succeeded with debug_id, one write with PayPal-Request-Id = action id, audit proposed → approved → checks → sent → succeeded", async () => {
    const s = await evidenceScene();
    const { d, http } = deps();
    serveDispute(server, STATE.waiting, s.ids, s.ws); // our re-fetch (check 5)
    serveDispute(server, STATE.waiting, s.ids, s.ws); // the client's own link re-check
    serveWrite(server, s.ids, "provide-evidence", EVIDENCE_OK);

    expect(await execute(d, s.actionId, s.ws)).toBe("succeeded");
    expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "succeeded", code: null });
    expect(writes(calls)).toEqual([
      { method: "POST", path: `/v1/customer/disputes/${s.ids.disputeId}/provide-evidence`, requestId: s.actionId },
    ]);
    const exec = await executionForAction(db, s.ws, s.actionId);
    expect(exec).toMatchObject({ idempotencyKey: s.actionId, paypalStatus: "200", paypalDebugId: "ca51fc56edb2d" });
    expect(http.breaker.state()).toBe("closed");

    const trail = await actionAuditTrail(db, s.ws, s.actionId);
    expect(trail.map((r) => (r.action === "action.check" ? `check:${String(r.detail["check"])}` : r.action))).toEqual([
      "action.proposed",
      "action.approved",
      "check:kill_switch",
      "check:payload_hash",
      "check:blob_hash",
      "check:ownership",
      "check:action_link",
      "check:deadline",
      "action.sent",
      "action.succeeded",
    ]);
    expect(trail.map((r) => r.actor)).toEqual(["agent", "seller", ...Array<string>(8).fill("system")]);
    expect(trail.find((r) => r.action === "action.sent")?.detail).toMatchObject({ debugId: "ca51fc56edb2d", status: 200 });
    // a targeted dispute re-sync follows the write
    const sync = await db.$client.query("select 1 from pgboss.job where name = 'paypal.dispute.sync' and data->'data'->>'disputeId' = $1", [s.ids.disputeId]);
    expect(sync.rowCount).toBe(1);
  });

  it("replays 422 ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE: failed PAYPAL_REJECTED, not retried, breaker untouched", async () => {
    const s = await evidenceScene();
    const { d, http } = deps();
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveWrite(server, s.ids, "provide-evidence", EVIDENCE_422);

    expect(await execute(d, s.actionId, s.ws)).toBe("failed");
    expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "PAYPAL_REJECTED" });
    expect(writes(calls)).toHaveLength(1);
    expect(await executionForAction(db, s.ws, s.actionId)).toMatchObject({ paypalStatus: "422", paypalDebugId: "ca51fb6196f52" });
    expect(http.breaker.state()).toBe("closed");
    expect(await jobs("action.reconcile", s.actionId)).toHaveLength(0);
  });

  describe("refusals: failed with the code, an audit row, and no PayPal write", () => {
    it("kill switch (env) → KILL_SWITCH, no PayPal request at all", async () => {
      const s = await evidenceScene();
      expect(await execute(deps({ killSwitchEnv: () => true }).d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "KILL_SWITCH" });
      expect(calls).toEqual([]);
    });

    it("kill switch (DB flag) → KILL_SWITCH, no PayPal request at all", async () => {
      const s = await evidenceScene();
      await platform(db).flags.setAgentKillSwitch(true);
      try {
        expect(await execute(deps().d, s.actionId, s.ws)).toBe("failed");
      } finally {
        await platform(db).flags.setAgentKillSwitch(false);
      }
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "KILL_SWITCH" });
      expect(calls).toEqual([]);
    });

    it("payload edited after approval → PAYLOAD_CHANGED, no PayPal request at all", async () => {
      const s = await evidenceScene();
      await db.$client.query(
        "update proposed_actions set payload = jsonb_set(payload, '{notes}', '\"edited after approval\"') where id = $1",
        [s.actionId],
      );
      expect(await execute(deps().d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "PAYLOAD_CHANGED" });
      expect(calls).toEqual([]);
      const trail = await actionAuditTrail(db, s.ws, s.actionId);
      expect(trail.at(-2)?.detail).toMatchObject({ check: "payload_hash", ok: false, code: "PAYLOAD_CHANGED" });
      expect(trail.at(-1)).toMatchObject({ action: "action.failed", detail: { code: "PAYLOAD_CHANGED" } });
    });

    it("compiled blob replaced → BLOB_CHANGED, no PayPal request at all", async () => {
      const s = await evidenceScene();
      await db.$client.query(
        "update blobs set bytes = $1 where id = (select compiled_blob_id from dispute_drafts where id = $2)",
        [Buffer.from("%PDF-1.4 swapped"), s.draftId],
      );
      expect(await execute(deps().d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "BLOB_CHANGED" });
      expect(calls).toEqual([]);
    });

    it("dispute owned by another workspace → NOT_OWNED, no PayPal request at all", async () => {
      const s = await evidenceScene();
      const other = await platform(db).workspaces.create({ kind: "demo", locale: "en", timezone: "UTC", baseCurrency: "USD" });
      created.push(other.id);
      await db.$client.query(
        "update paypal_resource_owner set workspace_id = $1 where resource_type = 'dispute' and resource_id = $2",
        [other.id, s.ids.disputeId],
      );
      expect(await execute(deps().d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "NOT_OWNED" });
      expect(calls).toEqual([]);
    });

    it("re-fetched dispute without the provide_evidence link (UNDER_REVIEW) → ACTION_LINK_MISSING, no write", async () => {
      const s = await evidenceScene();
      serveDispute(server, STATE.underReview, s.ids, s.ws);
      expect(await execute(deps().d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "ACTION_LINK_MISSING" });
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("at due − 59 min → DEADLINE_PASSED, no write", async () => {
      const s = await evidenceScene();
      serveDispute(server, STATE.waiting, s.ids, s.ws);
      const now = new Date(Date.parse("2026-11-09T04:59:59.000Z") - 59 * 60_000);
      expect(await execute(deps({ now: () => now }).d, s.actionId, s.ws)).toBe("failed");
      expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "failed", code: "DEADLINE_PASSED" });
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    });
  });

  it("timeout after the send → unknown, a reconcile job in 2 min with the pre-send snapshot, never resent", async () => {
    const s = await evidenceScene();
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveWrite(server, s.ids, "provide-evidence", EVIDENCE_OK, 1_500); // answers after the 300 ms write timeout

    expect(await execute(deps({ writeTimeoutMs: 300 }).d, s.actionId, s.ws)).toBe("unknown");
    expect(await stateOf(s.ws, s.actionId)).toEqual({ state: "unknown", code: null });
    expect(writes(calls)).toHaveLength(1);
    const [job] = await jobs("action.reconcile", s.actionId);
    expect(job?.data.data).toMatchObject({
      attempt: 1,
      before: { status: "WAITING_FOR_SELLER_RESPONSE", allowedActions: ["accept_claim", "provide_evidence"], sellerSubmissions: 1 },
    });
    expect((job?.start_after.getTime() ?? 0) - Date.now()).toBeGreaterThan(100_000);
    expect((await actionAuditTrail(db, s.ws, s.actionId)).at(-1)).toMatchObject({ action: "action.unknown" });
    await settleLateResponse();
  });

  it("job re-delivery sends at most once: one executions row, the same PayPal-Request-Id", async () => {
    const s = await evidenceScene();
    const { d } = deps();
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveWrite(server, s.ids, "provide-evidence", EVIDENCE_OK);

    expect(await execute(d, s.actionId, s.ws)).toBe("succeeded");
    expect(await execute(d, s.actionId, s.ws)).toBe("skipped");
    expect(writes(calls).map((c) => c.requestId)).toEqual([s.actionId]);
    const n = await db.$client.query("select idempotency_key from executions where action_id = $1", [s.actionId]);
    expect(n.rows).toEqual([{ idempotency_key: s.actionId }]);
  });

  it("a redelivery after a crash mid-send (state executing) never resends: unknown + reconcile", async () => {
    const s = await evidenceScene();
    // the crashed attempt committed its claim (executions row + executing) and then died
    await db.$client.query(
      "insert into executions (workspace_id, action_id, idempotency_key) values ($1, $2, $3)",
      [s.ws, s.actionId, s.actionId],
    );
    await db.$client.query("update proposed_actions set state = 'executing' where id = $1", [s.actionId]);

    expect(await execute(deps().d, s.actionId, s.ws)).toBe("unknown");
    expect(calls).toEqual([]);
    const [job] = await jobs("action.reconcile", s.actionId);
    expect(job?.data.data).toMatchObject({ attempt: 1, before: { status: "WAITING_FOR_SELLER_RESPONSE", sellerSubmissions: null } });
  });

  it("the multipart body carries the approved notes and the compiled PDF (by sha256)", async () => {
    const s = await evidenceScene();
    let body = "";
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") void request.clone().text().then((t) => (body = t));
    });
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveWrite(server, s.ids, "provide-evidence", EVIDENCE_OK);
    expect(await execute(deps().d, s.actionId, s.ws)).toBe("succeeded");
    expect(body).toContain('"evidence_type":"PROOF_OF_FULFILLMENT"');
    expect(body).toContain(`filename="evidence-${s.ids.disputeId}.pdf"`);
    expect(body).toContain("Cleared synthetic evidence pack");
    expect(PDF_SHA).toMatch(/^[0-9a-f]{64}$/);
    expect(BASE).toBe("https://api-m.sandbox.paypal.com");
  });
});
