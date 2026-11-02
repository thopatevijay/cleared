// LIVE (claims PAYPAL_SANDBOX; skipped without PAYPAL_CLIENT_ID or Postgres). The M3-03 live proof: one
// approved `add_tracking` with IND_DELHIVERY on a Cleared-owned sandbox order (card order with
// custom_id = workspace, owner rows written first, ADR 0008) runs through `action.execute` and PayPal
// answers 201. Prints the paypal-debug-id for the PR. Run from a worktree with the main `.env` inherited:
//   node --env-file=<main checkout>/.env ../../node_modules/vitest/vitest.mjs run src/actions/add-tracking.live.test.ts
// Note: the capture's webhooks go to the Render app (app-scoped webhook), which quarantines it as unowned
// (BL-01 6568286398, M3-09). Expected.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createHttpClient,
  createOwnedTestPayment,
  createPayPalOrdersClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
} from "@cleared/adapters";
import { WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import {
  actionAuditTrail,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  executionForAction,
  forWorkspace,
  getProposedAction,
  platform,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvedAction, ctxFor } from "../../test/actions-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { executeAction } from "../jobs/execute-action.ts";

const clientId = process.env["PAYPAL_CLIENT_ID"] ?? "";
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"] ?? "";

describe.skipIf(clientId === "" || clientSecret === "" || !dbAvailable)("add_tracking live (sandbox)", () => {
  const db = createDb(url);
  let boss: Queue;
  let publisher: Publisher;
  const http = createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials: { clientId, clientSecret },
  });
  const orders = createPayPalOrdersClient({ http, tokens });
  let ws = "";

  beforeAll(async () => {
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  afterAll(async () => {
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = $1", [ws]);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("an approved IND_DELHIVERY tracker on a Cleared-owned order returns 201 with a debug id", async () => {
    const w = await platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "Asia/Kolkata",
      baseCurrency: "USD",
    });
    ws = w.id;
    const owners = platform(db).resourceOwners;
    const paid = await createOwnedTestPayment(
      {
        orders,
        claimOrder: (orderId, workspaceId) =>
          owners.claim({ resourceType: "order", resourceId: orderId, workspaceId }).then(() => undefined),
      },
      { workspaceId: ws, requestId: randomUUID() },
    );
    await owners.claim({ resourceType: "capture", resourceId: paid.captureId, workspaceId: ws });
    const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
    await repos.payments.insert({
      captureId: paid.captureId,
      orderId: paid.orderId,
      amount: "42.00",
      currency: "USD",
      status: paid.status,
      source: "poll",
    });
    const payload: JsonValue = {
      order_id: paid.orderId,
      capture_id: paid.captureId,
      carrier: "IND_DELHIVERY",
      tracking_number: `CLR${randomBytes(6).toString("hex").toUpperCase()}`,
      notify_payer: false,
    };
    const actionId = await approvedAction(db, publisher, { ws, ids: {} as never }, "add_tracking", payload);
    const outcome = await withTransaction(db, (tx) =>
      executeAction(
        { db, publisher, disputes: {} as never, orders, now: () => new Date(), killSwitchEnv: () => false },
        { actionId, workspaceId: ws },
        ctxFor(tx, { actionId }),
      ),
    );
    const exec = await executionForAction(db, ws, actionId);
    console.log(
      JSON.stringify({
        m3_03_live: true,
        orderId: paid.orderId,
        captureId: paid.captureId,
        actionId,
        outcome,
        paypalStatus: exec?.paypalStatus,
        paypalDebugId: exec?.paypalDebugId,
        response: exec?.response,
      }),
    );
    expect(outcome).toBe("succeeded");
    expect((await getProposedAction(db, ws, actionId))?.state).toBe("succeeded");
    expect(exec?.paypalStatus).toBe("201");
    expect(exec?.paypalDebugId).toMatch(/^[a-z0-9]+$/);
    expect((await actionAuditTrail(db, ws, actionId)).map((a) => a.action)).toContain("action.sent");
  });
});
