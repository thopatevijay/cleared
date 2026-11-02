// M3-09 reconcile poll (architecture §6, ADR 0013): the backstop for lost, late or unordered webhooks
// (webhooks are app-scoped and can be lost) and for `unknown` executions whose reconcile chain was lost.
// Every 15 minutes, one tick (a singleton queue, and a transaction-scoped advisory lock: an overlapping
// tick is skipped) enqueues one idempotent sub-job per item, on the queues the webhooks already use:
// - owned captures that are PENDING or changed in the last 72 h → `paypal.capture.sync {source: poll}`
//   (the M1-04 consumer: re-fetch, mirror, `payment.status_changed`, which M3-01 turns into the hold
//   change; an unchanged capture writes nothing)
// - owned disputes not RESOLVED → `paypal.dispute.sync {source: poll}` (M2-06: status, due date, links)
// - `unknown` actions quiet for 45 min → one final `action.reconcile` try (M2-08 / M3-03 / M3-04 read-back)
// Only resources with an owner row in their workspace are listed: an unowned one is never fetched. Each
// sub-job has a job id derived from (item, 15-minute bucket), so a second tick in the same bucket adds
// nothing. Then the SLO checks run and the tick stores its own `reconcile` row (`/readyz` reads it), all in
// the tick's transaction; Sentry alerts go out after the commit.
import { createHash } from "node:crypto";
import {
  CHECK_NAMES,
  EXTRACT_PROMPT,
  isHoldActionKind,
  RECONCILE_CRON,
  RECONCILE_MAX_TRIES,
  RECONCILE_RECENT_MS,
  STRANDED_UNKNOWN_AFTER_MS,
  WorkspaceIdSchema,
  type Instant,
} from "@cleared/core";
import type { Logger } from "@cleared/adapters";
import {
  ACTION_RECONCILE_QUEUE,
  forWorkspace,
  OPS_RECONCILE_QUEUE,
  PAYPAL_CAPTURE_SYNC_QUEUE,
  PAYPAL_DISPUTE_SYNC_QUEUE,
  platform,
  scopeChecksRepo,
  withTransaction,
  type Db,
  type Publisher,
  type Queue,
  type StrandedAction,
  type Tx,
} from "@cleared/db";
import { NO_SNAPSHOT } from "../actions/hold-action.ts";
import { DisputeSnapshotSchema } from "./action-runtime.ts";
import { raiseAlerts, runSloChecks, type SloAlert, type StoredCheck } from "./slo-checks.ts";

export const BUCKET_MS = 15 * 60_000;
/** `pg_try_advisory_xact_lock` key of the reconcile tick. */
export const RECONCILE_LOCK_ID = 3_090_915;

export interface ReconcileDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly now: () => Date;
  readonly log: Logger;
  readonly alert?: SloAlert;
}

export interface ReconcileCounts {
  readonly captures: number;
  readonly disputes: number;
  readonly actions: number;
  /** stranded dispute actions without a recorded `before` snapshot: left for the seller, logged */
  readonly skippedActions: number;
  /** `collecting` packs whose scope check was nudged (BL-01 6537991625) */
  readonly packs: number;
}

export type ReconcileResult =
  | { readonly ran: false }
  | { readonly ran: true; readonly counts: ReconcileCounts; readonly checks: readonly StoredCheck[] };

/** A uuid derived from the parts: the same item in the same 15-minute bucket is one pg-boss job. */
export function jobIdFor(...parts: readonly string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  const variant = ((Number.parseInt(h.charAt(16), 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function tryLock(tx: Tx): Promise<boolean> {
  const r = await tx.execute(`select pg_try_advisory_xact_lock(${String(RECONCILE_LOCK_ID)}) as ok`);
  return (r.rows[0] as { ok: boolean } | undefined)?.ok === true;
}

/** The reconcile input of a stranded action's final try, or null when its snapshot was never recorded. */
function finalTry(a: StrandedAction) {
  const before = isHoldActionKind(a.kind) ? NO_SNAPSHOT : DisputeSnapshotSchema.safeParse(a.before).data;
  if (before === undefined) return null;
  return { actionId: a.actionId, workspaceId: a.workspaceId, attempt: RECONCILE_MAX_TRIES, before };
}

async function enqueueItems(deps: ReconcileDeps, tx: Tx, now: Date): Promise<ReconcileCounts> {
  const targets = platform(deps.db).reconcileTargets;
  const bucket = String(Math.floor(now.getTime() / BUCKET_MS));
  const captures = await targets.captures(new Date(now.getTime() - RECONCILE_RECENT_MS), tx);
  for (const c of captures) {
    const data = { captureId: c.captureId, source: "poll" as const };
    const jobId = jobIdFor("capture", c.captureId, bucket);
    await deps.publisher.enqueue(tx, PAYPAL_CAPTURE_SYNC_QUEUE, data, { workspaceId: c.workspaceId, jobId });
  }
  const disputes = await targets.disputes(tx);
  for (const d of disputes) {
    const data = { disputeId: d.disputeId, source: "poll" as const };
    const jobId = jobIdFor("dispute", d.disputeId, bucket);
    await deps.publisher.enqueue(tx, PAYPAL_DISPUTE_SYNC_QUEUE, data, { workspaceId: d.workspaceId, jobId });
  }
  const stranded = await targets.strandedActions(new Date(now.getTime() - STRANDED_UNKNOWN_AFTER_MS), tx);
  let actions = 0;
  for (const a of stranded) {
    const input = finalTry(a);
    if (input === null) {
      deps.log.warn({ actionId: a.actionId, kind: a.kind }, "reconcile: unknown action has no snapshot");
      continue;
    }
    const jobId = jobIdFor("action", a.actionId, bucket);
    await deps.publisher.enqueue(tx, ACTION_RECONCILE_QUEUE, input, { workspaceId: a.workspaceId, jobId });
    actions += 1;
  }
  return {
    captures: captures.length,
    disputes: disputes.length,
    actions,
    skippedActions: stranded.length - actions,
    packs: await nudgeStuckPacks(deps, tx, now),
  };
}

/**
 * BL-01 6537991625 (owner decision 2026-11-02): when a pack's last unfinished item ends without facts,
 * M2-03 emits no `pack.extracted`, so the scope check never runs and the pack stays `collecting`. Once
 * every item is finished (facts or `extract.no_facts`), the sweeper emits one `pack.extracted` for a facts
 * row of the pack (the M2-04 consumer is idempotent on the evidence set) and records `pack.scope_recheck`,
 * so each pack is nudged once: a check that then can't run (AI unavailable) is not retried every tick.
 */
async function nudgeStuckPacks(deps: ReconcileDeps, tx: Tx, now: Date): Promise<number> {
  let nudged = 0;
  for (const p of await platform(deps.db).reconcileTargets.stuckPacks(tx)) {
    const ws = WorkspaceIdSchema.parse(p.workspaceId);
    if ((await scopeChecksRepo(deps.db, ws).itemsAwaitingFacts(p.packId, EXTRACT_PROMPT.id, tx)).length > 0) {
      continue;
    }
    await deps.publisher.emit(tx, {
      type: "pack.extracted",
      version: 1,
      workspaceId: ws,
      occurredAt: now.toISOString() as Instant,
      data: { packId: p.packId, evidenceItemId: p.evidenceItemId, factsId: p.factsId, runId: p.runId },
    } as Parameters<Publisher["emit"]>[1]);
    await forWorkspace(deps.db, ws).auditLog.insert(
      { actor: "system", action: "pack.scope_recheck", detail: { packId: p.packId, factsId: p.factsId } },
      tx,
    );
    nudged += 1;
  }
  return nudged;
}

/** One reconcile tick. Returns `{ ran: false }` when another tick holds the lock. */
export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now();
  const out = await withTransaction(deps.db, async (tx) => {
    if (!(await tryLock(tx))) return null;
    const counts = await enqueueItems(deps, tx, now);
    const checks = await runSloChecks({ db: deps.db, now: () => now }, tx);
    await platform(deps.db).opsChecks.insert(
      [
        {
          runAt: now,
          check: CHECK_NAMES.reconcile,
          value: counts.captures + counts.disputes + counts.actions,
          target: null,
          pass: true,
          detail: { ...counts },
        },
      ],
      tx,
    );
    return { counts, checks };
  });
  if (out === null) {
    deps.log.info({}, "reconcile tick skipped: another tick is running");
    return { ran: false };
  }
  const alerts = raiseAlerts(out.checks, deps.alert);
  const failing = out.checks.filter((c) => !c.result.pass).map((c) => c.result.check);
  deps.log.info({ ...out.counts, failing, alerts }, "reconcile tick");
  return { ran: true, ...out };
}

/** Schedules the tick every 15 minutes on a singleton queue, consumes it, and runs one tick at boot. */
export async function scheduleReconcile(
  deps: ReconcileDeps & {
    readonly boss: Queue;
    readonly pollingIntervalSeconds?: number;
  },
): Promise<void> {
  if (!(await deps.boss.getQueue(OPS_RECONCILE_QUEUE))) {
    await deps.boss.createQueue(OPS_RECONCILE_QUEUE, {
      policy: "singleton",
      expireInSeconds: 120,
      retryLimit: 0,
    });
  }
  await deps.boss.schedule(OPS_RECONCILE_QUEUE, RECONCILE_CRON);
  await deps.boss.work(
    OPS_RECONCILE_QUEUE,
    deps.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: deps.pollingIntervalSeconds },
    async () => {
      await runReconcile(deps);
    },
  );
  // `/readyz` needs a tick within 30 minutes: don't wait up to 15 for the first cron one
  await deps.boss.send(OPS_RECONCILE_QUEUE, {});
}
