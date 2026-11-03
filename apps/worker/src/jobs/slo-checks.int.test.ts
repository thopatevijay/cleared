// M3-09 AC 4 (worker half): the SLO checks over crafted rows. The rows sit in a window far in the future
// (2031), so the latency samples are only this test's; each check passes, then breaches, and a breach
// calls the Sentry adapter (a spy) once per check per 6 hours; a synthetic workspace's rows don't count.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHECK_NAMES, type OpsCheckResult } from "@cleared/core";
import { closeDb, createDb, platform } from "@cleared/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { measureSlos, raiseAlerts, runSloChecks } from "./slo-checks.ts";

const db = createDb(url);
// a fresh day per run (the rows stay in the shared test database): 2031 + up to ~27 years
const T0 = Date.parse("2031-01-01T00:00:00Z") + Math.floor(Math.random() * 10_000) * 86_400_000;
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const NOW = at(12 * 60);
const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);

async function workspace(synthetic = false): Promise<string> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
    synthetic,
  });
  return ws.id;
}

// The recorded deliveries (M0-06, real sandbox): their bodies are what `webhook_events.raw` stores.
const DELIVERIES = fileURLToPath(
  new URL("../../../../fixtures/paypal/webhooks/deliveries/", import.meta.url),
);
type Delivery = { resource: Record<string, unknown> } & Record<string, unknown>;
const delivery = (name: string): Delivery =>
  JSON.parse(
    (JSON.parse(readFileSync(`${DELIVERIES}${name}.json`, "utf8")) as { raw_body: string }).raw_body,
  ) as Delivery;

/** `PAYMENT.CAPTURE.<status>` for `captureId`, on the recorded v2 capture body (PENDING carries its reason). */
function captureBody(captureId: string, status: "COMPLETED" | "PENDING", reason?: string): unknown {
  const body = delivery("payment-capture-completed");
  const resource = { ...body.resource, id: captureId, status };
  if (reason !== undefined) Object.assign(resource, { status_details: { reason } });
  return { ...body, event_type: `PAYMENT.CAPTURE.${status}`, resource };
}

/** `CUSTOMER.DISPUTE.CREATED` on the recorded body, with `captureId` as the disputed seller transaction. */
function disputeBody(captureId: string): unknown {
  const body = delivery("customer-dispute-created");
  const [tx] = body.resource["disputed_transactions"] as Record<string, unknown>[];
  const disputed = [{ ...tx, seller_transaction_id: captureId }];
  const disputeId = `PP-R-T-${randomUUID().slice(0, 8)}`;
  return { ...body, resource: { ...body.resource, dispute_id: disputeId, disputed_transactions: disputed } };
}

async function webhook(type: string, raw: unknown, received: Date): Promise<void> {
  await q(
    "insert into webhook_events (provider, event_id, type, raw, received_at) values ('paypal', $1, $2, $3, $4)",
    [`WH-${randomUUID()}`, type, JSON.stringify(raw), received],
  );
}

/** A payment row and its hold, visible at `visible`. */
async function hold(
  ws: string,
  captureId: string,
  h: { type: string; reason: string; visible: Date; source?: string },
): Promise<void> {
  const p = await q(
    "insert into payments (workspace_id, capture_id, amount, currency, status, status_reason, source) values ($1, $2, '10.00', 'USD', 'PENDING', $3, $4) returning id",
    [ws, captureId, h.reason, h.source ?? "webhook"],
  );
  await q(
    "insert into holds (workspace_id, payment_id, type, reason, opened_at, created_at) values ($1, $2, $3, $4, $5, $5)",
    [ws, (p.rows[0] as { id: string }).id, h.type, h.reason, h.visible],
  );
}

const newCaptureId = () => `S${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;

/** A `PAYMENT.CAPTURE.PENDING` delivery at `receivedMin`, and its review hold visible `seconds` later. */
async function holdAfterWebhook(ws: string, receivedMin: number, seconds: number): Promise<void> {
  const captureId = newCaptureId();
  const received = at(receivedMin);
  await webhook("PAYMENT.CAPTURE.PENDING", captureBody(captureId, "PENDING", "PENDING_REVIEW"), received);
  const visible = new Date(received.getTime() + seconds * 1000);
  await hold(ws, captureId, { type: "review", reason: "PENDING_REVIEW", visible });
}

/** An approval at `approvedMin` and its 2xx send `seconds` later. */
async function sendAfterApproval(ws: string, approvedMin: number, seconds: number): Promise<void> {
  const a = await q(
    "insert into proposed_actions (workspace_id, kind, payload, payload_sha256, state, risk) values ($1, 'provide_evidence', '{}', $2, 'succeeded', 'medium') returning id",
    [ws, "a".repeat(64)],
  );
  const id = (a.rows[0] as { id: string }).id;
  const approved = at(approvedMin);
  await q(
    "insert into approvals (workspace_id, action_id, approved_by, approved_at, payload_sha256) values ($1, $2, 'test', $3, $4)",
    [ws, id, approved, "a".repeat(64)],
  );
  await q(
    "insert into executions (workspace_id, action_id, idempotency_key, paypal_status, created_at) values ($1, $2, $3, '201', $4)",
    [ws, id, randomUUID(), new Date(approved.getTime() + seconds * 1000)],
  );
}

const byCheck = (rs: readonly OpsCheckResult[], check: string) => rs.find((r) => r.check === check);

describe.skipIf(!dbAvailable)("SLO checks (integration)", () => {
  afterAll(() => closeDb(db));
  const deps = { db, now: () => NOW };

  it("latency checks pass under target, breach over it; synthetic workspaces are left out", async () => {
    const ws = await workspace();
    await holdAfterWebhook(ws, 60, 5);
    await sendAfterApproval(ws, 60, 20);
    // a synthetic workspace's slow hold and send are not samples
    const syn = await workspace(true);
    await holdAfterWebhook(syn, 61, 900);
    await sendAfterApproval(syn, 61, 900);
    let r = await measureSlos(deps);
    expect(byCheck(r, CHECK_NAMES.holdVisible)).toMatchObject({
      pass: true,
      value: 5,
      detail: { samples: 1 },
    });
    expect(byCheck(r, CHECK_NAMES.approvedToPaypal)).toMatchObject({ pass: true, value: 20 });

    await holdAfterWebhook(ws, 120, 600);
    await sendAfterApproval(ws, 120, 400);
    r = await measureSlos(deps);
    expect(byCheck(r, CHECK_NAMES.holdVisible)).toMatchObject({
      pass: false,
      value: 600,
      detail: { samples: 2 },
    });
    expect(byCheck(r, CHECK_NAMES.approvedToPaypal)).toMatchObject({ pass: false, value: 400 });
  });

  // M3-GATE prep: production measured 201 s on 3 dispute holds, the time from the original
  // PAYMENT.CAPTURE.COMPLETED to the hold (PayPal's chargeback clock). A hold is now paired only with the
  // delivery that announced it. These rows sit in their own window (30 h), after every other test's.
  it("hold visible: pairs each hold with the webhook that announced it", async () => {
    const ws = await workspace();
    const samples = () => platform(db).sloSamples.holdVisibleSeconds(at(30 * 60), at(31 * 60));

    // a dispute hold: the capture COMPLETED 200 s before the dispute delivery, the hold 5 s after it
    const disputed = newCaptureId();
    const disputeAt = at(30 * 60 + 10);
    const completedAt = new Date(disputeAt.getTime() - 200_000);
    await webhook("PAYMENT.CAPTURE.COMPLETED", captureBody(disputed, "COMPLETED"), completedAt);
    await webhook("CUSTOMER.DISPUTE.CREATED", disputeBody(disputed), disputeAt);
    const disputeHold = new Date(disputeAt.getTime() + 5_000);
    await hold(ws, disputed, { type: "dispute", reason: "BUYER_COMPLAINT", visible: disputeHold });
    // a later dispute update (after the hold) is not its announcement
    await webhook(
      "CUSTOMER.DISPUTE.UPDATED",
      disputeBody(disputed),
      new Date(disputeHold.getTime() + 30_000),
    );
    expect(await samples()).toEqual([5]);

    // a capture PENDING hold is still measured, slow ones included (a real breach stays a breach)
    await holdAfterWebhook(ws, 30 * 60 + 20, 7);
    await holdAfterWebhook(ws, 30 * 60 + 25, 300);
    expect((await samples()).sort((a, b) => a - b)).toEqual([5, 7, 300]);

    // a poll-created hold: only a COMPLETED delivery before it, its PENDING delivery after → no sample
    const polled = newCaptureId();
    const polledAt = at(30 * 60 + 30);
    await webhook("PAYMENT.CAPTURE.COMPLETED", captureBody(polled, "COMPLETED"), at(30 * 60 + 27));
    await hold(ws, polled, { type: "review", reason: "PENDING_REVIEW", visible: polledAt, source: "poll" });
    const lateAt = new Date(polledAt.getTime() + 12_000);
    await webhook("PAYMENT.CAPTURE.PENDING", captureBody(polled, "PENDING", "PENDING_REVIEW"), lateAt);
    // a dispute delivery doesn't announce a non-dispute hold on the same capture
    await webhook("CUSTOMER.DISPUTE.CREATED", disputeBody(polled), new Date(polledAt.getTime() - 1_000));
    expect((await samples()).sort((a, b) => a - b)).toEqual([5, 7, 300]);
  });

  it("missed deadline: an open dispute past due with no filed action breaches", async () => {
    const ws = await workspace();
    const disputeId = `PP-D-${randomUUID().slice(0, 8)}`;
    await q(
      "insert into disputes (workspace_id, dispute_id, status, seller_response_due_date) values ($1, $2, 'WAITING_FOR_SELLER_RESPONSE', $3)",
      [ws, disputeId, at(-60)],
    );
    const r = byCheck(await measureSlos(deps), CHECK_NAMES.missedDeadlines);
    expect(r?.pass).toBe(false);
    expect(r?.value).toBeGreaterThanOrEqual(1);
    // filing an action for it takes it off the list
    const before = r?.value ?? 0;
    await q(
      "insert into proposed_actions (workspace_id, kind, payload, payload_sha256, state, risk) values ($1, 'provide_evidence', $2, $3, 'succeeded', 'medium')",
      [ws, JSON.stringify({ dispute_id: disputeId }), "b".repeat(64)],
    );
    expect(byCheck(await measureSlos(deps), CHECK_NAMES.missedDeadlines)?.value).toBe(before - 1);
  });

  it("synthetic freshness: a pass under 26 h passes, an older one breaches", async () => {
    await platform(db).opsChecks.insert([
      { runAt: at(11 * 60), check: CHECK_NAMES.synthetic, value: 900, target: 1800, pass: true },
    ]);
    expect(byCheck(await measureSlos(deps), CHECK_NAMES.syntheticFresh)).toMatchObject({
      pass: true,
      value: 3600,
    });
    const later = { db, now: () => at(40 * 60) };
    expect(byCheck(await measureSlos(later), CHECK_NAMES.syntheticFresh)?.pass).toBe(false);
  });

  it("a breach calls the Sentry adapter once per check per 6 hours; every result is stored", async () => {
    const spy = vi.fn();
    const when = at(14 * 60);
    const d = { db, now: () => when };
    const first = await runSloChecks(d);
    expect(first).toHaveLength(4);
    const breached = first.filter((s) => !s.result.pass).map((s) => s.result.check);
    expect(breached).toEqual(expect.arrayContaining([CHECK_NAMES.holdVisible, CHECK_NAMES.approvedToPaypal]));
    expect(raiseAlerts(first, spy)).toBe(breached.length);
    expect(spy.mock.calls.map((c) => (c[0] as OpsCheckResult).check).sort()).toEqual([...breached].sort());
    const stored = await q('select "check", pass, detail from ops_checks where run_at = $1', [when]);
    expect(stored.rows).toHaveLength(4);
    // 15 minutes later the same breaches are stored again but don't alert again
    const again = await runSloChecks({ db, now: () => at(14 * 60 + 15) });
    expect(raiseAlerts(again, spy)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(breached.length);
  });
});
