// M4-05 governance: with the kill switch on (env or DB flag), EVERY executable action kind is refused at
// execution with KILL_SWITCH, before any PayPal request. The kinds come from core's EXECUTABLE_KINDS, so
// a new kind is covered (and must be refused) the day it is added. The agent harness side (no model call
// with the switch on) is proven in packages/core/test/agent/harness.test.ts "runWorkflow: kill switch".
import { EXECUTABLE_KINDS } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  getProposedAction,
  platform,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAction, type ExecuteActionDeps } from "../../src/jobs/execute-action.ts";
import {
  approvedAction,
  ctxFor,
  disputesWithHttp,
  evidencePayload,
  NOW,
  recordCalls,
  sceneWithDispute,
  type PayPalCall,
} from "../actions-support.ts";
import { dbAvailable, url } from "../helpers.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
let calls: PayPalCall[];
const created: string[] = [];

/** Any write port touched at all is a failure: the kill switch must refuse before it. */
function untouchable(name: string): never {
  return new Proxy({} as never, {
    get: () => () => {
      throw new Error(`${name} called with the kill switch on`);
    },
  });
}

function deps(killSwitchEnv: boolean): ExecuteActionDeps {
  const { disputes } = disputesWithHttp(server);
  return {
    db,
    publisher,
    disputes,
    orders: untouchable("orders"),
    completed: untouchable("completed"),
    now: () => NOW,
    killSwitchEnv: () => killSwitchEnv,
  };
}

async function refused(kill: { env: boolean }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const kind of EXECUTABLE_KINDS) {
    const s = await sceneWithDispute(db, created);
    // Approve a valid action, then give it this kind: the kill switch is the first check, before the
    // payload hash or shape, so each kind's own execution route is what gets exercised.
    const actionId = await approvedAction(db, publisher, s, "provide_evidence", evidencePayload(s.ids, s.draftId));
    await db.$client.query("update proposed_actions set kind = $1 where id = $2", [kind, actionId]);
    await withTransaction(db, (tx) =>
      executeAction(deps(kill.env), { actionId, workspaceId: s.ws }, ctxFor(tx, { actionId })),
    );
    const row = await getProposedAction(db, s.ws, actionId);
    out[kind] = { state: row?.state, code: row?.refusalCode ?? null };
  }
  return out;
}

const allRefused = Object.fromEntries(EXECUTABLE_KINDS.map((k) => [k, { state: "failed", code: "KILL_SWITCH" }]));

describe.skipIf(!dbAvailable)("governance: the kill switch refuses every execution path", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  beforeEach(() => {
    calls = recordCalls(server);
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

  it("AGENT_KILL_SWITCH=true: every executable kind ends failed KILL_SWITCH, no PayPal request", async () => {
    expect(EXECUTABLE_KINDS.length).toBeGreaterThanOrEqual(5);
    expect(await refused({ env: true })).toEqual(allRefused);
    expect(calls).toEqual([]);
  });

  it("the DB flag alone does the same", async () => {
    await platform(db).flags.setAgentKillSwitch(true);
    try {
      expect(await refused({ env: false })).toEqual(allRefused);
    } finally {
      await platform(db).flags.setAgentKillSwitch(false);
    }
    expect(calls).toEqual([]);
  });
});
