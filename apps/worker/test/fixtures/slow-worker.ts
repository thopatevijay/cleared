// The real worker entry (same start, connect, shutdown) with one test queue whose job takes 2 s.
// Spawned by shutdown.test.ts: `SLOW_QUEUE=<name> node test/fixtures/slow-worker.ts`.
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@cleared/adapters";
import { makeConnect } from "../../src/connect.ts";
import { start } from "../../src/main.ts";
import type { Registry } from "../../src/registry.ts";
import { main } from "../../src/shutdown.ts";

const queue = process.env["SLOW_QUEUE"];
if (!queue) throw new Error("SLOW_QUEUE is required");

const log = createLogger({ service: "worker" });
const registry: Registry = [
  {
    queue: { name: queue, expireInSeconds: 30 },
    async handler(_data, ctx) {
      ctx.log.info("slow job started");
      await sleep(2_000);
      ctx.log.info("slow job finished");
    },
  },
];

main(() => start(process.env, log, makeConnect({ log, registry, pollingIntervalSeconds: 0.5 })), log);
