// M3-09 synthetic judge path, offline (the live run is the CLI against the sandbox): the run starts in a
// workspace flagged `synthetic` with the M2-10 capture job queued; each step's time is an `ops_checks` row;
// a step that doesn't finish within its budget fails the run at that step, raises the Sentry error (a spy)
// naming it, and the workspace is purged either way. A stand-in for the worker moves the scenario along.
import { randomBytes } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  ensureKnownQueues,
  forWorkspace,
  platform,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { runSyntheticJudgePath, type SyntheticDeps } from "./synthetic-judge-path.ts";

const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
const log = createLogger({ service: "worker-test", level: "silent" });

async function rowsOf(since: Date) {
  const r = await db.$client.query<{ check: string; pass: boolean; detail: Record<string, unknown> }>(
    `select "check", pass, detail from ops_checks where "check" like 'synthetic%' and run_at >= $1 and run_at < now() + interval '1 hour' order by "check"`,
    [since],
  );
  return r.rows;
}

function deps(over: Partial<SyntheticDeps>): SyntheticDeps {
  return { db, publisher, now: () => new Date(), log, pollMs: 20, ...over };
}

describe.skipIf(!dbAvailable)("synthetic judge path (offline)", () => {
  beforeAll(async () => {
    boss = await createQueue(db, { background: false, max: 2 });
    // another file's harness may have deleted queues this file emits to (helpers.ts › close)
    await ensureKnownQueues(boss);
    publisher = createPublisher(db, boss);
  });
  afterAll(async () => {
    await db.$client.query(
      "delete from pgboss.job where name = 'scenario.capture' and data->'data' ? 'scenarioId' and data->>'workspaceId' not in (select id::text from workspaces)",
    );
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("no worker: fails at `capture`, stores the timings, alerts with the step and purges the workspace", async () => {
    const since = new Date();
    const alert = vi.fn();
    const r = await runSyntheticJudgePath(deps({ alert, maxSeconds: 0.2 }));
    expect(r).toMatchObject({ pass: false, failedStep: "capture", purged: true });
    // the capture job was queued for the synthetic workspace, which is gone now
    const job = await db.$client.query(
      "select data->>'workspaceId' as ws from pgboss.job where name = 'scenario.capture' and data->'data'->>'scenarioId' = $1",
      [r.scenarioId],
    );
    expect(job.rows).toEqual([{ ws: r.workspaceId }]);
    // purged: only the synthetic workspace row (and any AI spend rows) remain
    expect((await platform(db).workspaces.get(r.workspaceId))?.synthetic).toBe(true);
    const left = await db.$client.query(
      "select count(*)::int as n from scenario_runs where workspace_id = $1",
      [r.workspaceId],
    );
    expect(left.rows[0]).toEqual({ n: 0 });
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0]?.[0] as Error).message).toBe("synthetic judge path failed at capture");
    expect(alert.mock.calls[0]?.[1]).toMatchObject({ failedStep: "capture", scenarioId: r.scenarioId });
    const rows = await rowsOf(since);
    expect(rows.map((x) => [x.check, x.pass])).toEqual([
      ["synthetic", false],
      ["synthetic.capture", false],
    ]);
    expect(rows[0]?.detail).toMatchObject({ failedStep: "capture" });
  });

  it("the steps advance as the scenario does; the first one that stalls fails the run", async () => {
    const since = new Date();
    const captureId = `Y${randomBytes(6).toString("hex").toUpperCase()}`;
    let seen: { workspaceId: string; flagged: boolean } | null = null;
    // a stand-in for the worker: on the first wait it captures, charges back and PayPal holds the capture
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length > 1) return;
      const run = await db.$client.query<{ id: string; workspace_id: string }>(
        "select r.id, r.workspace_id from scenario_runs r join workspaces w on w.id = r.workspace_id where w.synthetic and r.state = 'capturing' order by r.created_at desc limit 1",
      );
      const { id, workspace_id: ws } = run.rows[0] ?? { id: "", workspace_id: "" };
      seen = { workspaceId: ws, flagged: (await platform(db).workspaces.get(ws))?.synthetic === true };
      await forWorkspace(db, ws as never).payments.insert({
        captureId,
        amount: "120.00",
        currency: "USD",
        status: "PENDING",
        statusReason: "BUYER_COMPLAINT",
        source: "poll",
      });
      await db.$client.query(
        "update scenario_runs set state = 'polling', capture_id = $2, dispute_id = $3 where id = $1",
        [id, captureId, `PP-D-SYN-${captureId}`],
      );
    });
    const r = await runSyntheticJudgePath(deps({ sleep, alert: () => undefined, maxSeconds: 0.5 }));
    expect(seen).toEqual({ workspaceId: r.workspaceId, flagged: true });
    expect(r.steps.map((s) => [s.step, s.pass])).toEqual([
      ["capture", true],
      ["chargeback", true],
      ["buyer_complaint_hold", true],
      ["evidence_proposed", false],
    ]);
    expect(r).toMatchObject({ failedStep: "evidence_proposed", captureId, purged: true });
    expect((await rowsOf(since)).map((x) => x.check)).toEqual([
      "synthetic",
      "synthetic.buyer_complaint_hold",
      "synthetic.capture",
      "synthetic.chargeback",
      "synthetic.evidence_proposed",
    ]);
  });
});
