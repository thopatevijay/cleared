// Runs with Node's built-in type stripping: `node src/index.ts [--dry-run]`.
import { createLogger, setProcessLogger } from "@cleared/adapters";
import { makeConnect } from "./connect.ts";
import { dryRun, start } from "./main.ts";
import { defaultRegistry } from "./registry.ts";
import { initSentry } from "./sentry.ts";
import { main } from "./shutdown.ts";

const log = createLogger({ service: "worker" });
setProcessLogger(log);

if (process.argv.includes("--dry-run")) {
  process.exitCode = dryRun(log);
} else {
  log.info({ sentry: initSentry() }, "worker observability ready");
  main(() => start(process.env, log, makeConnect({ log, registry: defaultRegistry() })), log);
}
