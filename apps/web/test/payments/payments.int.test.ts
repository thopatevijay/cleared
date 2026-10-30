// M1-07: GET /api/payments (session-scoped list, pagination, per-currency held totals, waiting count)
// and POST /api/sandbox/test-payments (CSRF, idempotency, job + audit row in one tx, 3 per 24 h).
import { randomUUID } from "node:crypto";
import { PaymentsResponseSchema, WorkspaceIdSchema } from "@cleared/core";
import { createPublisher, createQueue, forWorkspace, type Publisher } from "@cleared/db";
import { afterEach, describe, expect, it } from "vitest";
import { postDemo } from "../../src/server/handlers/demo.ts";
import { getPayments, postTestPayment } from "../../src/server/handlers/payments.ts";
import { getWorkspace } from "../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

let pub: Promise<Publisher> | undefined;
const created: string[] = [];
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};

async function demo(): Promise<{ cookie: string; wsId: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const wsId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(wsId);
  return { cookie, wsId };
}

const list = async (cookie: string, query = "") => {
  const res = await getPayments(req(`/api/payments${query}`, { method: "GET", cookie }), testDeps());
  return { status: res.status, body: (await res.json()) as unknown };
};

describe.skipIf(!dbAvailable)("payments API (integration)", () => {
  it("no session → 401; bad paging → 400", async () => {
    expect((await list("__Host-cleared_session=" + "a".repeat(43))).status).toBe(401);
    const { cookie } = await demo();
    expect((await list(cookie, "?limit=51")).status).toBe(400);
    expect((await list(cookie, "?offset=-1")).status).toBe(400);
  });

  it("lists only the session's payments, newest first, with held totals per currency", async () => {
    const a = await demo();
    const b = await demo();
    const ra = forWorkspace(testDb(), WorkspaceIdSchema.parse(a.wsId));
    const rb = forWorkspace(testDb(), WorkspaceIdSchema.parse(b.wsId));
    const ins = (r: typeof ra, amount: string, status: string, currency = "USD") =>
      r.payments.insert({
        captureId: randomUUID().slice(0, 17),
        amount,
        currency,
        status,
        statusReason: status === "PENDING" ? "PENDING_REVIEW" : null,
        source: "webhook",
        receivableAmount: "40.00",
        receivableCurrency: "USD",
      });
    await ins(ra, "64.00", "PENDING");
    await ins(ra, "42.00", "COMPLETED");
    await ins(ra, "5.00", "PENDING", "EUR");
    await ins(rb, "999.00", "PENDING");

    const { status, body } = await list(a.cookie, `?workspaceId=${b.wsId}`);
    expect(status).toBe(200);
    const parsed = PaymentsResponseSchema.parse(body);
    expect(parsed.total).toBe(3);
    expect(parsed.items.map((i) => i.amount.value)).toEqual(["5.00", "42.00", "64.00"]);
    expect(parsed.items[0]?.statusReason).toBe("PENDING_REVIEW");
    expect(parsed.items[1]?.receivable).toEqual({ value: "40.00", currency: "USD" });
    expect(parsed.summary.held).toEqual([
      { value: "5.00", currency: "EUR" },
      { value: "64.00", currency: "USD" },
    ]);
    expect(parsed.workspace).toEqual({ kind: "demo", timezone: "UTC" });

    const page2 = PaymentsResponseSchema.parse((await list(a.cookie, "?offset=1&limit=1")).body);
    expect(page2.items.map((i) => i.amount.value)).toEqual(["42.00"]);
    expect(page2).toMatchObject({ offset: 1, limit: 1, total: 3 });
  });

  it("test payment: CSRF and idempotency, one job per request, waiting count, 3 per 24 h", async () => {
    const { cookie, wsId } = await demo();
    const deps = testDeps();
    const post = (key = randomUUID(), origin?: string | null) =>
      postTestPayment(
        req("/api/sandbox/test-payments", { cookie, key, ...(origin === undefined ? {} : { origin }) }),
        deps,
        publisher,
      );

    expect((await post(randomUUID(), "https://evil.example")).status).toBe(403);
    expect(
      (await postTestPayment(req("/api/sandbox/test-payments", { cookie, key: null }), deps, publisher))
        .status,
    ).toBe(400);

    const key = randomUUID();
    const first = await post(key);
    expect(first.status).toBe(202);
    const { messageId } = (await first.json()) as { messageId: string };
    const replay = await post(key);
    expect(replay.status).toBe(202);
    expect(((await replay.json()) as { messageId: string }).messageId).toBe(messageId);

    const jobs = await testDb().$client.query(
      "select data from pgboss.job where name = 'sandbox.test_payment' and data->>'messageId' = $1",
      [messageId],
    );
    expect(jobs.rowCount).toBe(1);
    expect((jobs.rows[0] as { data: { data: { workspaceId: string } } }).data.data.workspaceId).toBe(wsId);

    const waiting = PaymentsResponseSchema.parse((await list(cookie)).body).testPayments;
    expect(waiting).toEqual({ waiting: 1, usedToday: 1, limit: 3 });

    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    const capped = await post();
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: { code: string } }).error.code).toBe("test_payment_limit");
    expect(PaymentsResponseSchema.parse((await list(cookie)).body).testPayments.usedToday).toBe(3);
  });

  // The jobs are real pg-boss rows in the shared test database: remove them so a worker test running
  // against the same database never consumes them (they would fail without PayPal credentials).
  afterEach(async () => {
    await testDb().$client.query(
      "delete from pgboss.job where name = 'sandbox.test_payment' and data->'data'->>'workspaceId' = any($1)",
      [created],
    );
  });
});
