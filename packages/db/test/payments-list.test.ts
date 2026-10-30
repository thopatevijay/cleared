// M1-07: the dashboard reads (page, count, held totals per currency) and the test-payment counter stay
// inside one workspace.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { workspaceViews, type WorkspaceRepos } from "../src/repos/workspace/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { newWorkspace, paypalId } from "./graph.ts";

describe.skipIf(!dbAvailable)("workspace views: payments list + test-payment requests", () => {
  const db = createDb(TEST_DATABASE_URL);
  let a: WorkspaceRepos;
  let b: WorkspaceRepos;

  const pay = (r: WorkspaceRepos, amount: string, currency: string, status: string) =>
    r.payments.insert({
      captureId: paypalId(),
      amount,
      currency,
      status,
      statusReason: status === "PENDING" ? "PENDING_REVIEW" : null,
      source: "webhook",
    });

  beforeAll(async () => {
    a = await newWorkspace(db);
    b = await newWorkspace(db);
    await pay(a, "10.00", "USD", "PENDING");
    await pay(a, "2.50", "USD", "PENDING");
    await pay(a, "7", "EUR", "PENDING");
    await pay(a, "99.00", "USD", "COMPLETED");
    await pay(b, "500.00", "USD", "PENDING");
  });
  afterAll(() => closeDb(db));

  it("pages newest first with offset/limit and counts only its own rows", async () => {
    const v = workspaceViews(db, a.workspaceId);
    expect(await v.paymentsList.count()).toBe(4);
    const all = await v.paymentsList.page(0, 50);
    expect(all.map((p) => p.amount)).toEqual(["99.00", "7", "2.50", "10.00"]);
    const second = await v.paymentsList.page(1, 2);
    expect(second.map((p) => p.amount)).toEqual(["7", "2.50"]);
    expect(await workspaceViews(db, b.workspaceId).paymentsList.count()).toBe(1);
  });

  it("sums PENDING per currency, never across currencies or workspaces", async () => {
    expect(await workspaceViews(db, a.workspaceId).paymentsList.heldTotals()).toEqual([
      { value: "7", currency: "EUR" },
      { value: "12.50", currency: "USD" },
    ]);
  });

  it("records and counts test-payment requests per workspace", async () => {
    const v = workspaceViews(db, a.workspaceId);
    const before = new Date(Date.now() - 1000);
    await withTransaction(db, async (tx) => {
      await v.testPaymentRequests.lock(tx);
      await v.testPaymentRequests.record("6f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b", tx);
    });
    const got = await v.testPaymentRequests.since(before);
    expect(got.n).toBe(1);
    expect(got.oldest).toBeInstanceOf(Date);
    expect(await workspaceViews(db, b.workspaceId).testPaymentRequests.since(before)).toEqual({
      n: 0,
      oldest: null,
    });
    expect(await v.paymentsList.countCreatedSince(new Date(Date.now() + 60_000))).toBe(0);
  });
});
