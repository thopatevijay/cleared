// Runs with Node's built-in type stripping: `node src/index.ts [--dry-run]`.
import { connect } from "./connect.ts";
import { dryRun, start, type Log, type Worker } from "./main.ts";

const log: Log = (line) => {
  console.log(JSON.stringify(line));
};

function stopAndExit(worker: Worker, signal: NodeJS.Signals): void {
  worker.stop(signal).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      console.error(JSON.stringify({ service: "worker", msg: "stop failed", error: String(error) }));
      process.exitCode = 1;
    },
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    process.exitCode = dryRun(log);
    return;
  }
  // Handlers go in before start-up, so a SIGTERM that lands while connecting still stops cleanly.
  let worker: Worker | undefined = undefined;
  let pending: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (worker) stopAndExit(worker, signal);
    else pending = signal;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  worker = await start(process.env, log, connect);
  if (pending) stopAndExit(worker, pending);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ service: "worker", msg: "start failed", error: String(error) }));
  process.exit(1);
});
