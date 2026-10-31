// `action.reconcile` (M2-08 AC): a timed-out provide_evidence goes `unknown`; reconcile against the
// recorded post-evidence dispute (M0-05 disputes/full state-4: link gone, UNDER_REVIEW, seller evidence
// listed) → succeeded; against the unchanged dispute (state-3) → failed RECONCILE_NOT_APPLIED after 5 tries,
// and nothing is ever re-sent.
import {
  actionAuditTrail,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  getProposedAction,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { RECONCILE_MAX_TRIES } from "@cleared/core";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvedAction,
  ctxFor,
  disputesWithHttp,
  evidencePayload,
  NOW,
  recordCalls,
  sceneWithDispute,
  serveDispute,
  serveWrite,
  writes,
  type PayPalCall,
} from "../../test/actions-support.ts";
import { FULL, STATE } from "../../test/disputes-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { executeAction } from "./execute-action.ts";
import { reconcileAction, ReconcileActionInputSchema, type ReconcileOutcome } from "./reconcile-action.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
let calls: PayPalCall[];
const created: string[] = [];
const POST_EVIDENCE = `${FULL}/state-4-under_review`;

/** An approved provide_evidence whose write timed out: `unknown`, with its first reconcile job queued. */
async function unknownAction() {
  const s = await sceneWithDispute(db, created);
  const actionId = await approvedAction(
    db,
    publisher,
    s,
    "provide_evidence",
    evidencePayload(s.ids, s.draftId),
  );
  const { disputes } = disputesWithHttp(server);
  serveDispute(server, STATE.waiting, s.ids, s.ws);
  serveDispute(server, STATE.waiting, s.ids, s.ws);
  serveWrite(server, s.ids, "provide-evidence", "paypal/disputes/full/write-evidence.2", 1_500);
  const d = { db, publisher, disputes, now: () => NOW, killSwitchEnv: () => false, writeTimeoutMs: 300 };
  const out = await withTransaction(db, (tx) =>
    executeAction(d, { actionId, workspaceId: s.ws }, ctxFor(tx, {})),
  );
  expect(out).toBe("unknown");
  // let the delayed (timed-out) msw response finish before the next PayPal call
  await new Promise((r) => setTimeout(r, 1_500));
  return { ...s, actionId, disputes };
}

/** The pending reconcile job of `attempt` (as the worker would receive it). */
async function reconcileJob(actionId: string, attempt: number) {
  const r = await db.$client.query<{ data: { data: unknown } }>(
    "select data from pgboss.job where name = 'action.reconcile' and data->'data'->>'actionId' = $1 and (data->'data'->>'attempt')::int = $2",
    [actionId, attempt],
  );
  expect(r.rows).toHaveLength(1);
  return ReconcileActionInputSchema.parse(r.rows[0]?.data.data);
}

describe.skipIf(!dbAvailable)("action.reconcile (reconcile-action)", () => {
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
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("timeout → unknown; reconcile with the post-evidence dispute → succeeded (debug id kept null: no answer came)", async () => {
    const a = await unknownAction();
    serveDispute(server, POST_EVIDENCE, a.ids, a.ws);
    const input = await reconcileJob(a.actionId, 1);
    const deps = { db, publisher, disputes: a.disputes, now: () => NOW };
    const out: ReconcileOutcome = await withTransaction(db, (tx) =>
      reconcileAction(deps, input, ctxFor(tx, input)),
    );
    expect(out).toBe("succeeded");
    expect((await getProposedAction(db, a.ws, a.actionId))?.state).toBe("succeeded");
    expect(writes(calls)).toHaveLength(1); // the original send only
    const trail = (await actionAuditTrail(db, a.ws, a.actionId)).map((r) => r.action);
    expect(trail.slice(-4)).toEqual([
      "action.sent",
      "action.unknown",
      "action.reconcile",
      "action.succeeded",
    ]);
    // the mirror follows the re-read
    const m = await db.$client.query("select status from disputes where dispute_id = $1", [a.ids.disputeId]);
    expect(m.rows[0]).toEqual({ status: "UNDER_REVIEW" });
  });

  it("with the unchanged dispute → failed RECONCILE_NOT_APPLIED after 5 tries, never resent", async () => {
    const a = await unknownAction();
    const deps = { db, publisher, disputes: a.disputes, now: () => NOW };
    const outcomes: ReconcileOutcome[] = [];
    for (let attempt = 1; attempt <= RECONCILE_MAX_TRIES; attempt++) {
      serveDispute(server, STATE.waiting, a.ids, a.ws);
      const input = await reconcileJob(a.actionId, attempt);
      outcomes.push(await withTransaction(db, (tx) => reconcileAction(deps, input, ctxFor(tx, input))));
    }
    expect(outcomes).toEqual([
      "retry_scheduled",
      "retry_scheduled",
      "retry_scheduled",
      "retry_scheduled",
      "failed",
    ]);
    const row = await getProposedAction(db, a.ws, a.actionId);
    expect(row).toMatchObject({ state: "failed", refusalCode: "RECONCILE_NOT_APPLIED" });
    expect(writes(calls)).toHaveLength(1);
    const reconciles = (await actionAuditTrail(db, a.ws, a.actionId)).filter(
      (r) => r.action === "action.reconcile",
    );
    expect(reconciles.map((r) => r.detail["attempt"])).toEqual([1, 2, 3, 4, 5]);
    // a job delivered again after the action settled does nothing
    const late = await reconcileJob(a.actionId, 5);
    expect(await withTransaction(db, (tx) => reconcileAction(deps, late, ctxFor(tx, late)))).toBe("skipped");
  });
});
