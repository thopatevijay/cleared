// `pnpm --filter ./apps/worker run synthetic` (M3-09): one synthetic judge-path run now, on DATABASE_URL
// against the PayPal sandbox. It starts an in-process worker (the production registry), so the run needs
// nothing else running; then it prints each step's time and exits 0 on a pass, 1 on a failure.
// Reads DATABASE_URL, PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and OPENAI_API_KEY from the environment and
// never prints them. No Sentry here: a manual run reports on stdout (the scheduled run alerts).
// A local run's PayPal webhooks still go to the sandbox app's registered URL (BL-01 6568286398).
import { correlationIdOrNew, createLogger, setProcessLogger } from "@cleared/adapters";
import { closeDb, createDb, createPublisher, createQueue, databaseUrl } from "@cleared/db";
import { aiFromEnv } from "../ai.ts";
import { makeConnect } from "../connect.ts";
import { emailFromEnv } from "../email.ts";
import { runSyntheticJudgePath, type SyntheticResult } from "../jobs/synthetic-judge-path.ts";
import { paypalClientsFromEnv } from "../paypal.ts";
import { defaultRegistry } from "../registry.ts";

function summary(r: SyntheticResult): string {
  const lines = r.steps.map(
    (s) => `  ${s.pass ? "ok  " : "FAIL"} ${s.step.padEnd(22)} ${s.seconds.toFixed(1).padStart(7)} s`,
  );
  return [
    `synthetic judge path: ${r.pass ? "PASS" : "FAIL"} in ${r.totalSeconds.toFixed(1)} s (limit 1800 s)`,
    ...lines,
    `  failed step: ${r.failedStep ?? "none"}${r.error === null ? "" : ` (${r.error})`}`,
    `  capture ${r.captureId ?? "-"} · dispute ${r.disputeId ?? "-"} · scenario ${r.scenarioId}`,
    `  workspace purged: ${String(r.purged)}`,
  ].join("\n");
}

async function cli(): Promise<number> {
  const url = databaseUrl();
  const log = createLogger({ service: "synthetic" });
  setProcessLogger(log);
  const paypal = paypalClientsFromEnv(process.env);
  const ai = aiFromEnv(process.env);
  const email = emailFromEnv(process.env);
  const workerLog = createLogger({ service: "worker", level: "warn" });
  const worker = await makeConnect({
    log: workerLog,
    registry: (rt) => defaultRegistry(rt, paypal, ai, email),
    pollingIntervalSeconds: 1,
    // this process exists for one run: no cron ticks of its own (the scenario polls PayPal itself)
    opsSchedules: false,
  })(url);
  const db = createDb(url);
  const boss = await createQueue(db, { background: false, max: 2 });
  try {
    const publisher = createPublisher(db, boss, correlationIdOrNew);
    const result = await runSyntheticJudgePath({ db, publisher, now: () => new Date(), log });
    console.log(summary(result));
    return result.pass ? 0 : 1;
  } finally {
    await boss.stop({ graceful: false });
    await closeDb(db);
    await worker.stop();
  }
}

cli().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
