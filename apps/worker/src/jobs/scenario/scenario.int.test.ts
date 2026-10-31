// M2-10 judge scenario over the recorded sandbox exchanges (orders/test-payment, disputes/full): the step
// jobs walk a run to `resolved` with three owner rows (AC1), two workspaces stay apart (AC2), re-delivered
// or retried step jobs never create a second order or chargeback (AC4), the poll stops at a terminal state
// or 60 minutes (AC5), and the sandbox decision refuses without the `adjudicate` link (AC3, worker side).
import { randomUUID } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import { SCENARIO_POLL_LIMIT_MS, scenarioRequestIds, WorkspaceIdSchema } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
  type ScenarioRunRow,
} from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsumeContext } from "../../consume.ts";
import { dbAvailable, url } from "../../../test/helpers.ts";
import { installSandbox, sandboxClients, type Phase, type Sandbox } from "../../../test/scenario-support.ts";
import { runCaptureStep } from "./capture.ts";
import { runChargebackStep } from "./chargeback.ts";
import { runDecideStep } from "./decide.ts";
import { runPollStep } from "./poll.ts";
import { runSeedPackStep } from "./seed-pack.ts";
import type { ScenarioDeps, ScenarioJob } from "./shared.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let sandbox: Sandbox;
const created: string[] = [];
let clock = new Date("2026-10-31T12:00:00Z");

const deps = (): ScenarioDeps => ({
  db,
  publisher: createPublisher(db, boss),
  ...sandboxClients(),
  now: () => clock,
});

type Step<T> = (d: ScenarioDeps, job: ScenarioJob, ctx: ConsumeContext) => Promise<T>;

/** One delivery of a step job in its own transaction (what `consume()` does). */
async function deliver<T>(step: Step<T>, job: ScenarioJob, opts: { rollback?: boolean } = {}): Promise<T> {
  const log = createLogger({ service: "worker-test", level: "silent" });
  const meta = { id: randomUUID(), retryCount: 0, createdOn: clock } as JobWithMetadata<unknown>;
  let out: T | undefined;
  await withTransaction(db, async (tx) => {
    out = await step(deps(), job, {
      tx,
      log,
      job: meta,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: job },
    });
    if (opts.rollback === true) throw new Error("simulated crash after the step's PayPal call");
  }).catch((e: unknown) => {
    if (opts.rollback !== true) throw e;
  });
  return out as T;
}

async function start(): Promise<{ job: ScenarioJob; ws: string }> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  created.push(ws.id);
  const run = await repo(ws.id).insert({});
  sandbox.add(ws.id);
  return { job: { scenarioId: run.id, workspaceId: ws.id }, ws: ws.id };
}

const repo = (ws: string) => forWorkspace(db, WorkspaceIdSchema.parse(ws)).scenarioRuns;
const runRow = async (job: ScenarioJob): Promise<ScenarioRunRow> => {
  const r = await repo(job.workspaceId).get(job.scenarioId);
  if (r === null) throw new Error("run missing");
  return r;
};
const setPhase = (ws: string, phase: Phase): void => {
  sandbox.byWorkspace(ws).phase = phase;
};

async function owners(ws: string): Promise<{ type: string; id: string }[]> {
  const r = await db.$client.query<{ type: string; id: string }>(
    "select resource_type as type, resource_id as id from paypal_resource_owner where workspace_id = $1 order by resource_type",
    [ws],
  );
  return r.rows;
}

async function jobs(queue: string, scenarioId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*) as n from pgboss.job where name = $1 and data->'data'->>'scenarioId' = $2",
    [queue, scenarioId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** A provide_evidence that M2-08 executed (`succeeded` + its audit row), as the approve path leaves it. */
async function evidenceFiled(ws: string, disputeId: string): Promise<void> {
  const r = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const action = await r.proposedActions.insert({
    kind: "provide_evidence",
    payload: { dispute_id: disputeId },
    payloadSha256: "0".repeat(64),
    state: "succeeded",
    risk: "high",
  });
  await r.auditLog.insert({ actor: "system", action: "action.succeeded", detail: { actionId: action.id } });
}

async function toPolling(): Promise<{ job: ScenarioJob; ws: string }> {
  const s = await start();
  expect(await deliver(runCaptureStep, s.job)).toBe("done");
  expect(await deliver(runSeedPackStep, s.job)).toBe("done");
  expect(await deliver(runChargebackStep, s.job)).toBe("done");
  return s;
}

describe.skipIf(!dbAvailable)("judge scenario (fixture replay)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    sandbox = installSandbox(server);
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterAll(async () => {
    server.close();
    // Nothing consumes these here: drop this file's jobs.
    await db.$client.query(
      "delete from pgboss.job where data->>'workspaceId' = any($1) or data->'data'->>'workspaceId' = any($1)",
      [created],
    );
    await boss.stop({ graceful: false, close: true });
    await closeDb(db);
  });

  it("AC1: card capture with custom_id = workspace, three owner rows, steps walk to resolved", async () => {
    clock = new Date("2026-10-31T12:00:00Z");
    const { job, ws } = await start();
    const pp = sandbox.byWorkspace(ws);

    expect(await deliver(runCaptureStep, job)).toBe("done");
    let run = await runRow(job);
    expect(run).toMatchObject({ state: "seeding", orderId: pp.orderId, captureId: pp.captureId });
    const payment = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).payments.getByCaptureId(pp.captureId);
    expect(payment).toMatchObject({ status: "COMPLETED", source: "poll", orderId: pp.orderId });
    const capture = await sandboxClients().captures.getCapture(pp.captureId);
    expect(capture.mirror.customId).toBe(ws);
    expect(await jobs("scenario.seed_pack", job.scenarioId)).toBe(1);
    const captured = await db.$client.query(
      "select 1 from outbox where topic = 'payment.captured' and payload->'data'->>'captureId' = $1",
      [pp.captureId],
    );
    expect(captured.rowCount).toBe(1);

    expect(await deliver(runSeedPackStep, job)).toBe("done");
    run = await runRow(job);
    expect(run.state).toBe("charging_back");
    const items = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).evidenceItems.list();
    expect(items.map((i) => i.kind).sort()).toEqual(["communication", "delivery", "scope"]);

    expect(await deliver(runChargebackStep, job)).toBe("done");
    run = await runRow(job);
    expect(run).toMatchObject({ state: "polling", disputeId: pp.disputeId });
    // exactly three owner rows, all this workspace's (ordered by the enum: order, capture, dispute)
    expect(await owners(ws)).toEqual([
      { type: "order", id: pp.orderId },
      { type: "capture", id: pp.captureId },
      { type: "dispute", id: pp.disputeId },
    ]);

    for (const phase of ["underReview", "waiting", "adjudicable", "resolved"] as const) {
      setPhase(ws, phase);
      clock = new Date(clock.getTime() + 30_000);
      expect(await deliver(runPollStep, job)).toBe("continue");
    }
    setPhase(ws, "released");
    clock = new Date(clock.getTime() + 30_000);
    expect(await deliver(runPollStep, job)).toBe("resolved");
    run = await runRow(job);
    expect(run).toMatchObject({ state: "resolved", polls: 5 });
    expect(run.finishedAt).not.toBeNull();
    const dispute = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).disputes.getByDisputeId(pp.disputeId);
    expect(dispute).toMatchObject({
      status: "RESOLVED",
      outcome: { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" },
    });
    // AC5: no poll runs for a finished scenario
    const before = { ...pp.calls };
    expect(await deliver(runPollStep, job)).toBe("skipped");
    expect(pp.calls).toEqual(before);
    expect(pp.calls).toMatchObject({ create: 1, confirm: 1, capture: 1, chargeback: 1 });
  });

  it("AC4: re-delivered step jobs make no second PayPal create or chargeback call", async () => {
    clock = new Date("2026-10-31T13:00:00Z");
    const { job, ws } = await start();
    const pp = sandbox.byWorkspace(ws);
    // a crash after the order calls: the retry replays with the same PayPal-Request-Ids (Orders v2 replays)
    await deliver(runCaptureStep, job, { rollback: true });
    expect(await deliver(runCaptureStep, job)).toBe("done");
    expect(new Set(pp.createRequestIds)).toEqual(new Set([scenarioRequestIds(job.scenarioId).payment]));
    // a plain re-delivery after the step committed: no PayPal call at all
    const afterCapture = { ...pp.calls };
    expect(await deliver(runCaptureStep, job)).toBe("skipped");
    expect(pp.calls).toEqual(afterCapture);

    expect(await deliver(runSeedPackStep, job)).toBe("done");
    expect(await deliver(runSeedPackStep, job)).toBe("skipped");
    expect(await forWorkspace(db, WorkspaceIdSchema.parse(ws)).evidenceItems.list()).toHaveLength(3);

    // a crash after the chargeback landed: the retry adopts the capture's dispute instead of a second one
    await deliver(runChargebackStep, job, { rollback: true });
    expect(pp.calls.chargeback).toBe(1);
    expect(await deliver(runChargebackStep, job)).toBe("done");
    expect(pp.calls.chargeback).toBe(1);
    const run = await runRow(job);
    expect(run.disputeId).toBe(pp.disputeId);
    expect(run.steps).toMatchObject({ chargeback: { adopted: true } });
    expect(await deliver(runChargebackStep, job)).toBe("skipped");
    expect(pp.calls.chargeback).toBe(1);
  });

  it("AC5: the poll gives up at 60 minutes without calling PayPal, and schedules nothing after", async () => {
    clock = new Date("2026-10-31T14:00:00Z");
    const { job, ws } = await toPolling();
    const pp = sandbox.byWorkspace(ws);
    setPhase(ws, "waiting");
    clock = new Date(clock.getTime() + SCENARIO_POLL_LIMIT_MS - 1_000);
    expect(await deliver(runPollStep, job)).toBe("continue");
    const polls = await jobs("scenario.poll", job.scenarioId);
    const calls = { ...pp.calls };
    clock = new Date(clock.getTime() + 1_000);
    expect(await deliver(runPollStep, job)).toBe("timed_out");
    expect(pp.calls).toEqual(calls);
    expect(await runRow(job)).toMatchObject({ state: "timed_out", failure: "poll_limit" });
    expect(await jobs("scenario.poll", job.scenarioId)).toBe(polls);
  });

  it("AC2: two workspaces running at once never see each other's payments or disputes", async () => {
    clock = new Date("2026-10-31T15:00:00Z");
    const [a, b] = await Promise.all([toPolling(), toPolling()]);
    await Promise.all(
      [a, b].map(async (s) => {
        setPhase(s.ws, "waiting");
        await deliver(runPollStep, s.job);
      }),
    );
    const ppA = sandbox.byWorkspace(a.ws);
    const ppB = sandbox.byWorkspace(b.ws);
    const ra = forWorkspace(db, WorkspaceIdSchema.parse(a.ws));
    const rb = forWorkspace(db, WorkspaceIdSchema.parse(b.ws));
    expect((await ra.payments.list()).map((p) => p.captureId)).toEqual([ppA.captureId]);
    expect((await rb.payments.list()).map((p) => p.captureId)).toEqual([ppB.captureId]);
    expect((await ra.disputes.list()).map((d) => d.disputeId)).toEqual([ppA.disputeId]);
    expect((await rb.disputes.list()).map((d) => d.disputeId)).toEqual([ppB.disputeId]);
    expect(await ra.disputes.getByDisputeId(ppB.disputeId)).toBeNull();
    expect(await ra.scenarioRuns.get(b.job.scenarioId)).toBeNull();
    // a step job carrying the other workspace's id finds no run and calls nothing
    const calls = { ...ppB.calls };
    expect(await deliver(runPollStep, { scenarioId: b.job.scenarioId, workspaceId: a.ws })).toBe("skipped");
    expect(ppB.calls).toEqual(calls);
    expect((await owners(a.ws)).map((o) => o.id).sort()).toEqual(
      [ppA.orderId, ppA.captureId, ppA.disputeId].sort(),
    );
  });

  it("AC3 (worker): the decision refuses without the adjudicate link, then sends once PayPal offers it", async () => {
    clock = new Date("2026-10-31T16:00:00Z");
    const { job, ws } = await toPolling();
    const pp = sandbox.byWorkspace(ws);
    await evidenceFiled(ws, pp.disputeId);
    await repo(ws).update(job.scenarioId, { decisionRequestedAt: clock });
    setPhase(ws, "waiting");
    expect(await deliver(runDecideStep, job)).toBe("refused");
    expect(pp.calls.adjudicate).toBe(0);
    expect(await runRow(job)).toMatchObject({
      decisionError: "ACTION_LINK_MISSING",
      decisionRequestedAt: null,
    });

    await repo(ws).update(job.scenarioId, { decisionRequestedAt: clock });
    setPhase(ws, "adjudicable");
    expect(await deliver(runDecideStep, job)).toBe("sent");
    expect(pp.calls.adjudicate).toBe(1);
    const run = await runRow(job);
    expect(run.decisionSentAt).not.toBeNull();
    // re-delivery: nothing more is sent
    expect(await deliver(runDecideStep, job)).toBe("skipped");
    expect(pp.calls.adjudicate).toBe(1);
    const audit = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).auditLog.list();
    expect(audit.find((r) => r.action === "scenario.decision_sent")?.detail).toMatchObject({
      sandbox_decision: true,
      disputeId: pp.disputeId,
      outcome: "SELLER_FAVOR",
    });
    expect(await repo(ws).evidenceFiledAt(pp.disputeId)).not.toBeNull();
  });
});
