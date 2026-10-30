// Runs with Node's built-in type stripping: `node src/index.ts [--dry-run]`.
import { createLogger } from "@cleared/adapters";
import { makeConnect } from "./connect.ts";
import { dryRun, start } from "./main.ts";
import { defaultRegistry } from "./registry.ts";
import { main } from "./shutdown.ts";

const log = createLogger({ service: "worker" });

if (process.argv.includes("--dry-run")) {
  process.exitCode = dryRun(log);
} else {
  main(() => start(process.env, log, makeConnect({ log, registry: defaultRegistry() })), log);
}
