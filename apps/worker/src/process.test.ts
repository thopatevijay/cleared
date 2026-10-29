// Integration: the real process against the compose Postgres (`make up`). Skips when it is unreachable.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "@cleared/db";
import { describe, expect, it } from "vitest";
import { connect } from "./connect.ts";

const url = databaseUrl();

async function reachable(): Promise<boolean> {
  try {
    await (await connect(url)).stop();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await reachable();
if (!dbAvailable) console.warn(`worker process test skipped: no Postgres at DATABASE_URL (run make up)`);

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

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
      if (!child.killed && out.includes('"worker ready"')) child.kill("SIGTERM");
    });
    const [code] = (await once(child, "exit")) as [number | null];
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(code).toBe(0);
    expect(lines).toEqual([
      { service: "worker", msg: "worker ready", commit: "testcommit" },
      { service: "worker", msg: "worker stopping", commit: "testcommit", signal: "SIGTERM" },
      { service: "worker", msg: "worker stopped", commit: "testcommit" },
    ]);
  }, 30_000);
});
