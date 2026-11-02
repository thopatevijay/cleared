// M3-01 local E2E support: held payments seeded from the recorded wallet-review capture through the
// product path (payment row + `payment.captured` in one transaction; the running worker's holds consumer
// derives the hold), PayPal's release (the spike's re-read: COMPLETED at its update_time, then
// `payment.status_changed`), and the ui-reviewer captures under .review/M3-01/ (gitignored).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { CaptureIdSchema, fromEpochMs, type WorkspaceId } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  databaseUrl,
  forWorkspace,
  withTransaction,
  type Db,
  type Publisher,
} from "@cleared/db";
import { expect, type Page } from "@playwright/test";
import { seedHeldPayment, type HeldPaymentOptions } from "../../test/support/hold-seed.ts";

export const REVIEW_HOLDS = fileURLToPath(new URL("../../../../.review/M3-01/", import.meta.url));

async function withPublisher<T>(fn: (db: Db, pub: Publisher) => Promise<T>): Promise<T> {
  const db = createDb(databaseUrl());
  const boss = await createQueue(db, { background: false, max: 2 });
  try {
    return await fn(db, createPublisher(db, boss));
  } finally {
    await boss.stop({ graceful: false });
    await closeDb(db);
  }
}

async function holdIdFor(captureId: string): Promise<string | null> {
  const db = createDb(databaseUrl());
  try {
    const r = await db.$client.query<{ id: string }>(
      "select h.id from holds h join payments p on p.id = h.payment_id where p.capture_id = $1",
      [captureId],
    );
    return r.rows[0]?.id ?? null;
  } finally {
    await closeDb(db);
  }
}

/** Seeds a held payment and waits for the worker to derive its hold; returns the ids. */
export async function seedHeld(
  ws: string,
  o: HeldPaymentOptions = {},
): Promise<{ captureId: string; paymentId: string; holdId: string }> {
  const s = await withPublisher((db, pub) => seedHeldPayment(db, ws, o, pub));
  await expect
    .poll(() => holdIdFor(s.captureId), { timeout: 60_000, message: "the worker derives the hold" })
    .not.toBeNull();
  return { ...s, holdId: (await holdIdFor(s.captureId)) ?? "" };
}

/** A PENDING payment PayPal gave no reason for (not a hold): the worker derives nothing. */
export async function seedReasonless(ws: string, amount: string): Promise<string> {
  const s = await withPublisher((db, pub) => seedHeldPayment(db, ws, { amount, reason: null }, pub));
  return s.captureId;
}

/** PayPal released it: COMPLETED at the recorded re-read's update_time, then `payment.status_changed`. */
export async function releaseHeld(ws: string, captureId: string): Promise<void> {
  const after = JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/paypal/captures/pending-review-released.json", import.meta.url),
      "utf8",
    ),
  ) as { response: { body: { status: string; update_time: string } } };
  const body = after.response.body;
  await withPublisher((db, pub) =>
    withTransaction(db, async (tx) => {
      const repos = forWorkspace(db, ws as WorkspaceId);
      const p = await repos.payments.getByCaptureId(captureId, tx);
      if (p === null) throw new Error("no payment");
      await repos.payments.update(
        p.id,
        { status: body.status, statusReason: null, paypalUpdatedAt: new Date(body.update_time) },
        tx,
      );
      await pub.emit(tx, {
        type: "payment.status_changed",
        version: 1,
        workspaceId: ws as WorkspaceId,
        occurredAt: fromEpochMs(Date.now()),
        data: {
          captureId: CaptureIdSchema.parse(captureId),
          from: { status: p.status, reason: p.statusReason },
          to: { status: body.status, reason: null },
          source: "poll",
          updateTime: fromEpochMs(new Date(body.update_time).getTime()),
        },
      });
    }),
  );
}

/** Every WCAG 2.2 A/AA rule, any impact: the AC is "no WCAG 2.2 AA violations". */
export async function axeClean(page: Page, label: string): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `axe on ${label}`,
  ).toEqual([]);
}
