// M3-08: the 15-minute watcher's deadline alerts. Each T-72 / T-24 row is written once with exactly one
// `notification.send_email` job; a renewed `seller_response_due_date` on the same dispute gets its own pair
// (BL-01 6536548146); the stored data carries amount, reason code and due date only.
import { randomUUID } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import { addMinutes, WorkspaceIdSchema, type Instant } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  NOTIFICATION_SEND_EMAIL_QUEUE,
  platform,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { RECORDED_DUE } from "../../test/disputes-support.ts";
import { runDeadlineWatch } from "./deadline-watcher.ts";

const db = createDb(url);
let boss: Queue;
const log = createLogger({ service: "worker-test", level: "silent" });
const before = (due: string, minutes: number): Date => new Date(addMinutes(due as Instant, -minutes));
const tick = (now: Date) =>
  runDeadlineWatch({ db, publisher: createPublisher(db, boss), log, now: () => now });

async function dispute(due: string) {
  const ws = await platform(db).workspaces.create({
    kind: "seller",
    locale: "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
  });
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws.id));
  const row = await repos.disputes.insert({
    disputeId: `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    status: "WAITING_FOR_SELLER_RESPONSE",
    stage: "CHARGEBACK",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: "120.00",
    currency: "USD",
    sellerResponseDueDate: new Date(due),
    allowedActions: ["accept_claim", "provide_evidence"],
    paypalUpdatedAt: new Date("2026-10-29T05:20:34.178Z"),
  });
  return { repos, id: row.id };
}

async function alerts(d: Awaited<ReturnType<typeof dispute>>) {
  return (await d.repos.disputes.notificationsFor(d.id)).map((n) => ({
    kind: n.kind,
    key: n.dedupeKey,
    id: n.id,
    data: n.data,
  }));
}

async function emailJobs(ids: readonly string[]): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*) as n from pgboss.job where name = $1 and data->'data'->>'notificationId' = any($2)",
    [NOTIFICATION_SEND_EMAIL_QUEUE, ids],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!dbAvailable)("deadline alerts", () => {
  beforeAll(async () => {
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("T-72 and T-24 once each across 15-minute ticks, each with one email job", async () => {
    const d = await dispute(RECORDED_DUE);
    // 15-minute ticks across both thresholds (the full 80 h sweep is the core unit test)
    for (const [from, to] of [
      [73 * 60, 71 * 60],
      [25 * 60, 23 * 60],
    ] as const) {
      for (let m = from; m >= to; m -= 15) await tick(before(RECORDED_DUE, m));
    }
    const rows = await alerts(d);
    expect(rows.map((r) => r.kind)).toEqual(["deadline_t72", "deadline_t24"]);
    expect(rows.map((r) => r.key)).toEqual([
      `deadline_t72:${d.id}:${RECORDED_DUE}`,
      `deadline_t24:${d.id}:${RECORDED_DUE}`,
    ]);
    expect(rows[1]?.data).toEqual({
      amount: { amount: "120.00", currency: "USD" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dueDate: RECORDED_DUE,
      releaseDate: null,
      paymentId: null,
    });
    expect(await emailJobs(rows.map((r) => r.id))).toBe(2);
  });

  it("a renewed due date on the same dispute alerts again (BL-01 6536548146)", async () => {
    const d = await dispute(RECORDED_DUE);
    await tick(before(RECORDED_DUE, 71 * 60));
    await tick(before(RECORDED_DUE, 23 * 60));
    // PayPal returns the case to WAITING_FOR_SELLER_RESPONSE with a new, later due date (M0-05 require-evidence)
    const renewed = new Date(addMinutes(RECORDED_DUE as Instant, 4 * 24 * 60)).toISOString();
    await d.repos.disputes.update(d.id, { sellerResponseDueDate: new Date(renewed), deadlineState: "ok" });
    await tick(before(renewed, 71 * 60));
    await tick(before(renewed, 23 * 60));
    await tick(before(renewed, 22 * 60));
    const rows = await alerts(d);
    expect(rows.map((r) => r.key)).toEqual([
      `deadline_t72:${d.id}:${RECORDED_DUE}`,
      `deadline_t24:${d.id}:${RECORDED_DUE}`,
      `deadline_t72:${d.id}:${renewed}`,
      `deadline_t24:${d.id}:${renewed}`,
    ]);
    expect(await emailJobs(rows.map((r) => r.id))).toBe(4);
  });
});
