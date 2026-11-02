// M3-09 SLO checks (architecture §9), run after each reconcile poll: the samples come from the database,
// the verdicts from core (`packages/core/src/ops/slo.ts`), and every result is one `ops_checks` row.
// A breach raises a Sentry warning through the adapter, at most once per check per 6 hours (the tick runs
// every 15 minutes; Sentry's free quota must survive a breach that lasts a day). The row says whether it
// alerted (`detail.alerted`), so the throttle survives restarts and the runbook can read it (M4-07).
import {
  approvedToPaypalCheck,
  CHECK_NAMES,
  holdVisibleCheck,
  isDisputeOpen,
  mapDisputeState,
  missedDeadlinesCheck,
  SLO_WINDOW_MS,
  syntheticFreshCheck,
  type OpsCheckResult,
} from "@cleared/core";
import { reportWarning } from "@cleared/adapters";
import { platform, type Db, type Executor } from "@cleared/db";

export const ALERT_EVERY_MS = 6 * 60 * 60_000;

/** Raises the Sentry warning for one breached check (the adapter; tests pass a spy). */
export type SloAlert = (result: OpsCheckResult) => void;

export const sentrySloAlert: SloAlert = (r) => {
  reportWarning(`SLO breach: ${r.check}`, {
    extra: { check: r.check, value: r.value, target: r.target, ...r.detail },
  });
};

export interface SloDeps {
  readonly db: Db;
  readonly now: () => Date;
}

/** Measures the four SLOs at `now` (pure verdicts over the stored samples). */
export async function measureSlos(deps: SloDeps, tx?: Executor): Promise<OpsCheckResult[]> {
  const now = deps.now();
  const since = new Date(now.getTime() - SLO_WINDOW_MS);
  const p = platform(deps.db);
  const [holdVisible, approved, deadlines, lastPass] = await Promise.all([
    p.sloSamples.holdVisibleSeconds(since, tx),
    p.sloSamples.approvedToPaypalSeconds(since, tx),
    p.sloSamples.deadlines(tx),
    p.opsChecks.latest(CHECK_NAMES.synthetic, { pass: true }, tx),
  ]);
  const samples = deadlines.map((d) => ({
    disputeId: d.disputeId,
    open: isDisputeOpen(mapDisputeState({ status: d.status, stage: null, outcomeCode: null })),
    dueAtMs: d.dueAt === null ? null : d.dueAt.getTime(),
    filed: d.filed,
  }));
  return [
    holdVisibleCheck(holdVisible),
    approvedToPaypalCheck(approved),
    missedDeadlinesCheck(samples, now.getTime()),
    syntheticFreshCheck(lastPass === null ? null : lastPass.runAt.getTime(), now.getTime()),
  ];
}

export interface StoredCheck {
  readonly result: OpsCheckResult;
  /** a breach that raises its Sentry warning once the transaction commits */
  readonly alert: boolean;
}

async function alertedRecently(deps: SloDeps, check: string, tx?: Executor): Promise<boolean> {
  const since = new Date(deps.now().getTime() - ALERT_EVERY_MS);
  return platform(deps.db).opsChecks.alertedSince(check, since, tx);
}

/** Measures, decides which breaches alert, and stores one row per check (in `tx`). */
export async function runSloChecks(deps: SloDeps, tx?: Executor): Promise<StoredCheck[]> {
  const results = await measureSlos(deps, tx);
  const stored: StoredCheck[] = [];
  for (const result of results) {
    const alert = !result.pass && !(await alertedRecently(deps, result.check, tx));
    stored.push({ result, alert });
  }
  await platform(deps.db).opsChecks.insert(
    stored.map(({ result: r, alert }) => ({
      runAt: deps.now(),
      check: r.check,
      value: r.value,
      target: r.target,
      pass: r.pass,
      detail: { ...r.detail, alerted: alert },
    })),
    tx,
  );
  return stored;
}

/** After the commit: one Sentry warning per breach that is due one. */
export function raiseAlerts(stored: readonly StoredCheck[], alert: SloAlert = sentrySloAlert): number {
  let n = 0;
  for (const s of stored) {
    if (!s.alert) continue;
    alert(s.result);
    n += 1;
  }
  return n;
}
