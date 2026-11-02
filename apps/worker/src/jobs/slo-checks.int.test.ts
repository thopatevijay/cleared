// M3-09 AC 4 (worker half): the SLO checks over crafted rows. The rows sit in a window far in the future
// (2031), so the latency samples are only this test's; each check passes, then breaches, and a breach
// calls the Sentry adapter (a spy) once per check per 6 hours; a synthetic workspace's rows don't count.
import { randomUUID } from "node:crypto";
import { CHECK_NAMES, type OpsCheckResult } from "@cleared/core";
import { closeDb, createDb, platform } from "@cleared/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { measureSlos, raiseAlerts, runSloChecks } from "./slo-checks.ts";

const db = createDb(url);
const T0 = Date.parse("2031-01-01T00:00:00Z");
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

/** A webhook about a capture at `receivedMin`, and its hold row visible `seconds` later. */
async function holdAfterWebhook(ws: string, receivedMin: number, seconds: number): Promise<void> {
  const captureId = `S${randomUUID().slice(0, 12).toUpperCase()}`;
  const received = at(receivedMin);
  await q(
    "insert into webhook_events (provider, event_id, type, raw, received_at) values ('paypal', $1, 'PAYMENT.CAPTURE.PENDING', $2, $3)",
    [`WH-${randomUUID()}`, JSON.stringify({ resource: { id: captureId } }), received],
  );
  const p = await q(
    "insert into payments (workspace_id, capture_id, amount, currency, status, status_reason, source) values ($1, $2, '10.00', 'USD', 'PENDING', 'PENDING_REVIEW', 'webhook') returning id",
    [ws, captureId],
  );
  await q(
    "insert into holds (workspace_id, payment_id, type, reason, opened_at, created_at) values ($1, $2, 'payment_review', 'PENDING_REVIEW', $3, $4)",
    [ws, (p.rows[0] as { id: string }).id, received, new Date(received.getTime() + seconds * 1000)],
  );
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
