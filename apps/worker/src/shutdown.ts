// Process lifecycle (M0-08, M1-03): SIGTERM (Render) or SIGINT stops the worker gracefully. pg-boss
// stops fetching, lets the in-flight jobs finish (bounded by STOP_TIMEOUT_MS), then the pool closes and
// the process exits 0. Signal handlers go in before start-up, so a SIGTERM while connecting still stops.
import type { Logger } from "@cleared/adapters";
import type { Worker } from "./main.ts";

function stopAndExit(worker: Worker, signal: NodeJS.Signals, log: Logger): void {
  worker.stop(signal).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      log.error({ error: String(error) }, "stop failed");
      process.exitCode = 1;
    },
  );
}

export async function runUntilSignal(boot: () => Promise<Worker>, log: Logger): Promise<void> {
  let worker: Worker | undefined = undefined;
  let pending: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (worker) stopAndExit(worker, signal, log);
    else pending = signal;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  worker = await boot();
  if (pending) stopAndExit(worker, pending, log);
}

/** Entry helper: runs the worker and exits 1 when start-up fails. */
export function main(boot: () => Promise<Worker>, log: Logger): void {
  runUntilSignal(boot, log).catch((error: unknown) => {
    log.error({ error: String(error) }, "start failed");
    process.exit(1);
  });
}
