// AC Shutdown: SIGTERM during a 2 s job completes that job and exits 0. Spawns the worker process (the
// real start/connect/shutdown code with a 2 s test queue) against the compose Postgres.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { closeDb, createDb, createQueue, platform, sendEnvelope, withTransaction } from "@cleared/db";
import { describe, expect, it } from "vitest";
import { dlqName } from "../src/queues.ts";
import { dbAvailable, testQueue, until, url, type LogLine } from "./helpers.ts";

const entry = fileURLToPath(new URL("./fixtures/slow-worker.ts", import.meta.url));

describe.skipIf(!dbAvailable)("graceful shutdown (spawned worker)", () => {
  it("SIGTERM during a 2 s job lets the job complete, then exits 0", async () => {
    const queue = testQueue("slow");
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, DATABASE_URL: url, SLOW_QUEUE: queue },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines: LogLine[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (part.trim()) lines.push(JSON.parse(part) as LogLine);
    });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    const has = (msg: string) => lines.some((l) => l.msg === msg);

    const db = createDb(url);
    const boss = await createQueue(db);
    try {
      await until(() => has("worker ready"));
      const envelope = { messageId: randomUUID(), correlationId: "corr-sigterm", data: {} };
      const id = await withTransaction(db, (tx) => sendEnvelope(boss, tx, queue, envelope));

      await until(() => has("slow job started"));
      const sentAt = Date.now();
      child.kill("SIGTERM");
      const [code] = await exited;
      const elapsed = Date.now() - sentAt;

      expect(code).toBe(0);
      const order = lines
        .map((l) => l.msg)
        .filter(
          (m) =>
            m !== undefined &&
            [
              "slow job started",
              "worker stopping",
              "slow job finished",
              "message consumed",
              "worker stopped",
            ].includes(m),
        );
      expect(order).toEqual([
        "slow job started",
        "worker stopping",
        "slow job finished",
        "message consumed",
        "worker stopped",
      ]);
      expect(elapsed).toBeGreaterThan(1_000); // it waited for the job instead of dropping it
      const [job] = await boss.findJobs(queue, { id: id ?? "" });
      expect(job).toMatchObject({ state: "completed", output: { consumed: true } });
      expect(await platform(db).consumerReceipts.record(queue, envelope.messageId)).toBe(false);
      console.log(`SIGTERM → exit 0 in ${String(elapsed)} ms`);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await boss.deleteQueue(queue);
      await boss.deleteQueue(dlqName(queue));
      await boss.stop({ graceful: false });
      await closeDb(db);
    }
  }, 40_000);
});
