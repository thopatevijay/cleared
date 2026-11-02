// Integration: the real entry (`src/index.ts`) against the compose Postgres (`make up`). Skips when it
// is unreachable (fails instead with REQUIRE_DB=1, see helpers.ts).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dbAvailable, url } from "./helpers.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const LIFECYCLE = new Set(["worker ready", "worker stopping", "worker stopped"]);

describe.skipIf(!dbAvailable)("worker process", () => {
  it("starts pg-boss, logs `worker ready` with the commit, and exits 0 on SIGTERM", async () => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, DATABASE_URL: url, RENDER_GIT_COMMIT: "testcommit" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!child.killed && out.includes('"msg":"worker ready"')) child.kill("SIGTERM");
    });
    const [code] = (await once(child, "exit")) as [number | null];
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(code).toBe(0);
    expect(lines[0]).toMatchObject({ service: "worker", msg: "worker observability ready", sentry: false });
    // Scheduled jobs may log in between (the `*/15` deadline watcher, the outbox relay sweep: BL-01
    // 6537689293), so assert the lifecycle lines in order and that nothing logged an error.
    expect(lines.filter((l) => l.level === "error" || l.level === "fatal")).toEqual([]);
    expect(lines.slice(1).filter((l) => LIFECYCLE.has(l.msg as string))).toEqual([
      expect.objectContaining({
        service: "worker",
        level: "info",
        msg: "worker ready",
        commit: "testcommit",
      }),
      expect.objectContaining({
        service: "worker",
        msg: "worker stopping",
        commit: "testcommit",
        signal: "SIGTERM",
      }),
      expect.objectContaining({ service: "worker", msg: "worker stopped", commit: "testcommit" }),
    ]);
  }, 30_000);
});
