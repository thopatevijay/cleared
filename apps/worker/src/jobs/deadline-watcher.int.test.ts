// Deadline watcher (M2-06 AC): with the clock at due − 71 h one `dispute_deadline_72h`; at due − 23 h one
// `dispute_deadline_24h`; re-runs add none; at due − 59 min `deadline_state = closed_for_action`. Plus the
// 15-minute cron is registered with pg-boss.
import { randomUUID } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import { addMinutes, WorkspaceIdSchema, type Instant } from "@cleared/core";
import {
  closeDb,
  createDb,
  createQueue,
  DISPUTE_DEADLINE_WATCH_CRON,
  DISPUTE_DEADLINE_WATCH_QUEUE,
  forWorkspace,
  platform,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { RECORDED_DUE } from "../../test/disputes-support.ts";
import { runDeadlineWatch, scheduleDeadlineWatch } from "./deadline-watcher.ts";

const db = createDb(url);
let boss: Queue;
const log = createLogger({ service: "worker-test", level: "silent" });
const before = (minutes: number): Date => new Date(addMinutes(RECORDED_DUE as Instant, -minutes));

async function dispute(status: string, due: string | null) {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  const repo = forWorkspace(db, WorkspaceIdSchema.parse(ws.id)).disputes;
  const row = await repo.insert({
    disputeId: `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    status,
    stage: "CHARGEBACK",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    sellerResponseDueDate: due === null ? null : new Date(due),
    allowedActions: ["accept_claim", "provide_evidence"],
    paypalUpdatedAt: new Date("2026-10-29T05:20:34.178Z"),
  });
  return { repo, id: row.id };
}

async function kinds(d: Awaited<ReturnType<typeof dispute>>): Promise<string[]> {
  return (await d.repo.notificationsFor(d.id)).map((n) => n.kind);
}

const tick = (now: Date) => runDeadlineWatch({ db, log, now: () => now });

describe.skipIf(!dbAvailable)("deadline watcher", () => {
  beforeAll(async () => {
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterAll(async () => {
    await boss.unschedule(DISPUTE_DEADLINE_WATCH_QUEUE).catch(() => undefined);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("t72 → one 72 h alert; t24 → one 24 h alert; re-runs add none; due − 59 min → closed_for_action", async () => {
    const d = await dispute("WAITING_FOR_SELLER_RESPONSE", RECORDED_DUE);

    await tick(before(73 * 60));
    expect((await d.repo.get(d.id))?.deadlineState).toBe("ok");
    expect(await kinds(d)).toEqual([]);

    await tick(before(71 * 60));
    expect((await d.repo.get(d.id))?.deadlineState).toBe("t72");
    expect(await kinds(d)).toEqual(["dispute_deadline_72h"]);
    await tick(before(71 * 60 - 15));
    await tick(before(70 * 60));
    expect(await kinds(d)).toEqual(["dispute_deadline_72h"]);

    await tick(before(23 * 60));
    expect((await d.repo.get(d.id))?.deadlineState).toBe("t24");
    expect(await kinds(d)).toEqual(["dispute_deadline_72h", "dispute_deadline_24h"]);
    await tick(before(23 * 60 - 15));
    await tick(before(2 * 60));
    expect(await kinds(d)).toEqual(["dispute_deadline_72h", "dispute_deadline_24h"]);

    await tick(before(59));
    expect((await d.repo.get(d.id))?.deadlineState).toBe("closed_for_action");
    expect(await kinds(d)).toEqual(["dispute_deadline_72h", "dispute_deadline_24h"]);
    // closed_for_action is no longer scanned
    const watched = await platform(db).disputeDeadlines.watched(5_000);
    expect(watched.some((w) => w.id === d.id)).toBe(false);
  });

  it("first seen inside 24 h: only the 24 h alert", async () => {
    const d = await dispute("WAITING_FOR_SELLER_RESPONSE", RECORDED_DUE);
    await tick(before(10 * 60));
    expect(await kinds(d)).toEqual(["dispute_deadline_24h"]);
  });

  it("resolved disputes and disputes without a due date are not watched", async () => {
    const resolved = await dispute("RESOLVED", RECORDED_DUE);
    const noDue = await dispute("UNDER_REVIEW", null);
    await tick(before(23 * 60));
    expect(await kinds(resolved)).toEqual([]);
    expect(await kinds(noDue)).toEqual([]);
    expect((await resolved.repo.get(resolved.id))?.deadlineState).toBe("ok");
  });

  it("the watcher is scheduled every 15 minutes", async () => {
    await scheduleDeadlineWatch({ db, boss, log, now: () => new Date(), pollingIntervalSeconds: 0.5 });
    const schedules = await boss.getSchedules();
    expect(schedules.find((s) => s.name === DISPUTE_DEADLINE_WATCH_QUEUE)).toMatchObject({
      cron: DISPUTE_DEADLINE_WATCH_CRON,
    });
    expect(DISPUTE_DEADLINE_WATCH_CRON).toBe("*/15 * * * *");
  });
});
