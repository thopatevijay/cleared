// Runs with Node's built-in type stripping: `node src/index.ts [--dry-run]`.
import { createLogger, setProcessLogger } from "@cleared/adapters";
import { aiFromEnv } from "./ai.ts";
import { makeConnect } from "./connect.ts";
import { emailFromEnv } from "./email.ts";
import { dryRun, start } from "./main.ts";
import { defaultRegistry } from "./registry.ts";
import { paypalClientsFromEnv } from "./paypal.ts";
import { initSentry } from "./sentry.ts";
import { main } from "./shutdown.ts";

const log = createLogger({ service: "worker" });
setProcessLogger(log);

if (process.argv.includes("--dry-run")) {
  process.exitCode = dryRun(log);
} else {
  log.info({ sentry: initSentry() }, "worker observability ready");
  const paypal = paypalClientsFromEnv(process.env);
  const ai = aiFromEnv(process.env);
  const email = emailFromEnv(process.env);
  main(
    () =>
      start(
        process.env,
        log,
        makeConnect({
          log,
          registry: (rt) => defaultRegistry(rt, paypal, ai, email),
          // M3-09: the reconcile poll and the synthetic run; off only for the stubbed local E2E
          opsSchedules: process.env["OPS_SCHEDULES"] !== "off",
        }),
      ),
    log,
  );
}
