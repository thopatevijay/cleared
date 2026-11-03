// M4-07 demo retention purge (ADR 0020): once per UTC day (`retention.purge`, core RETENTION_PURGE_CRON) it
// empties every demo workspace whose purge is due (core `isPurgeDue`: expires_at + 6 days, so 2026-12-22 for
// the judging cohort). Seller workspaces and the review-hold pool workspace are never candidates.
// Each workspace is one transaction calling `purge_workspace(uuid)`, the SECURITY DEFINER function that
// deletes its rows (append-only tables included), detaches its review-hold pool rows, sets `purged_at` and
// writes one counts-only platform audit row. A purged workspace is never a candidate again, so a re-run
// purges 0. One workspace's failure is reported (Sentry) and the rest still run.
// PayPal sandbox resources (orders, captures, disputes) can't be deleted; only Cleared's copies are.
//
// On demand: `pnpm --filter @cleared/worker exec tsx src/jobs/retention-purge.ts [--dry-run] [--workspace <id>]…`
// on DATABASE_URL. `--dry-run` prints what would be removed and changes nothing. `FAKE_NOW` (an ISO
// instant; test and rehearsal only, never set in production) replaces the clock.
import { fromEpochMs, isPurgeDue, parseInstant, RETENTION_PURGE_CRON, type Instant } from "@cleared/core";
import { createLogger, reportError, type Logger } from "@cleared/adapters";
import {
  closeDb,
  createDb,
  databaseUrl,
  OPS_RETENTION_PURGE_QUEUE,
  platform,
  withTransaction,
  type Db,
  type PurgeCounts,
  type Queue,
  type RetentionCandidate,
} from "@cleared/db";

export interface RetentionPurgeDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly log: Logger;
  /** print the counts only; nothing changes */
  readonly dryRun?: boolean;
  /** only these workspaces (a manual run, a test); the policy still decides which of them are due */
  readonly workspaceIds?: readonly string[];
  readonly alert?: (error: unknown, extra: Record<string, unknown>) => void;
}

export interface PurgedWorkspace {
  readonly workspaceId: string;
  readonly synthetic: boolean;
  readonly counts: PurgeCounts;
}

export interface RetentionPurgeResult {
  readonly dryRun: boolean;
  readonly now: string;
  /** demo workspaces looked at (unpurged, not the pool) */
  readonly candidates: number;
  readonly purged: readonly PurgedWorkspace[];
  readonly failed: readonly string[];
  /** total rows removed (or, in a dry run, that would be) */
  readonly rows: number;
}

const instantOf = (d: Date): Instant => fromEpochMs(d.getTime());

function isDue(c: RetentionCandidate, now: Instant): boolean {
  return isPurgeDue(
    {
      kind: "demo",
      createdAt: instantOf(c.createdAt),
      expiresAt: c.expiresAt === null ? null : instantOf(c.expiresAt),
    },
    now,
  );
}

const total = (counts: PurgeCounts): number => Object.values(counts).reduce((a, b) => a + b, 0);

/** One pass of the purge (or of the dry run). */
export async function runRetentionPurge(deps: RetentionPurgeDeps): Promise<RetentionPurgeResult> {
  const repo = platform(deps.db).retention;
  const now = instantOf(deps.now());
  const dryRun = deps.dryRun === true;
  const candidates = await repo.candidates(deps.workspaceIds);
  const purged: PurgedWorkspace[] = [];
  const failed: string[] = [];
  for (const c of candidates.filter((x) => isDue(x, now))) {
    try {
      const counts = dryRun
        ? await repo.counts(c.id)
        : await withTransaction(deps.db, (tx) => repo.purge(c.id, tx));
      purged.push({ workspaceId: c.id, synthetic: c.synthetic, counts });
    } catch (e) {
      failed.push(c.id);
      deps.log.error(
        { workspaceId: c.id, err: e instanceof Error ? e.message : String(e) },
        "retention purge failed",
      );
      (deps.alert ?? reportError)(e, { workspaceId: c.id, job: OPS_RETENTION_PURGE_QUEUE });
    }
  }
  const rows = purged.reduce((a, p) => a + total(p.counts), 0);
  const result = { dryRun, now, candidates: candidates.length, purged, failed, rows };
  deps.log.info(
    { dryRun, now, candidates: candidates.length, purged: purged.length, failed: failed.length, rows },
    dryRun ? "retention purge dry run" : "retention purge done",
  );
  return result;
}

/** Once a day on a singleton queue; never retried (the next day's run is the retry, and it is idempotent). */
export async function scheduleRetentionPurge(
  deps: RetentionPurgeDeps & { readonly boss: Queue; readonly pollingIntervalSeconds?: number },
): Promise<void> {
  if (!(await deps.boss.getQueue(OPS_RETENTION_PURGE_QUEUE))) {
    await deps.boss.createQueue(OPS_RETENTION_PURGE_QUEUE, {
      policy: "singleton",
      expireInSeconds: 15 * 60,
      retryLimit: 0,
    });
  }
  await deps.boss.schedule(OPS_RETENTION_PURGE_QUEUE, RETENTION_PURGE_CRON);
  await deps.boss.work(
    OPS_RETENTION_PURGE_QUEUE,
    deps.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: deps.pollingIntervalSeconds },
    async () => {
      await runRetentionPurge({ db: deps.db, now: deps.now, log: deps.log });
    },
  );
}

/** The printed report: one line per workspace with its non-zero counts, then the totals. */
export function formatReport(r: RetentionPurgeResult): string {
  const lines = r.purged.map((p) => {
    const nonZero = Object.entries(p.counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t}=${String(n)}`)
      .join(" ");
    return `  ${p.workspaceId}${p.synthetic ? " (synthetic)" : ""}: ${String(total(p.counts))} rows ${nonZero}`.trimEnd();
  });
  return [
    `retention purge${r.dryRun ? " (dry run: nothing changed)" : ""} at ${r.now}`,
    `  demo workspaces not yet purged: ${String(r.candidates)}`,
    `  ${r.dryRun ? "would purge" : "purged"}: ${String(r.purged.length)} workspaces, ${String(r.rows)} rows`,
    ...lines,
    `  failed: ${String(r.failed.length)}${r.failed.length > 0 ? ` (${r.failed.join(", ")})` : ""}`,
  ].join("\n");
}

/** `--dry-run`, `--workspace <id>` (repeatable) and `FAKE_NOW`. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { dryRun: boolean; workspaceIds?: string[]; now: () => Date } {
  const ids: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--workspace") ids.push(argv[++i] ?? "");
    else throw new Error(`unknown argument: ${a ?? ""}`);
  }
  const fake = env["FAKE_NOW"];
  let now = (): Date => new Date();
  if (fake !== undefined && fake !== "") {
    const p = parseInstant(fake);
    if (!p.ok) throw new Error("FAKE_NOW must be an ISO instant with a zone");
    const fixed = new Date(p.value);
    now = () => fixed;
  }
  return { dryRun, now, ...(ids.length > 0 ? { workspaceIds: ids } : {}) };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, process.env);
  const db = createDb(databaseUrl());
  try {
    const log = createLogger({ service: "retention-purge", level: "warn" });
    const r = await runRetentionPurge({ db, log, ...args });
    console.log(formatReport(r));
    return r.failed.length === 0 ? 0 : 1;
  } finally {
    await closeDb(db);
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "retention purge failed");
      process.exitCode = 1;
    },
  );
}
