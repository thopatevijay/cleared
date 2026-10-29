import { describe, expect, it, vi } from "vitest";
import { commitOf, dryRun, start, type Connect } from "./main.ts";

function collect(): { lines: Record<string, unknown>[]; log: (l: Record<string, unknown>) => void } {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (l) => lines.push(l) };
}

describe("worker entry", () => {
  it("logs one JSON line and exits 0 in --dry-run", () => {
    const { lines, log } = collect();
    expect(dryRun(log)).toBe(0);
    expect(lines).toEqual([{ service: "worker", msg: "dry run: nothing to consume", dryRun: true }]);
  });

  it("reads the commit from RENDER_GIT_COMMIT", () => {
    expect(commitOf({ RENDER_GIT_COMMIT: "abc" })).toBe("abc");
    expect(commitOf({})).toBeNull();
  });

  it("connects to DATABASE_URL, logs `worker ready` with the commit, and stops once", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const connect = vi.fn<Connect>(() => Promise.resolve({ stop }));
    const { lines, log } = collect();
    const env = { DATABASE_URL: "postgres://x@h/db", RENDER_GIT_COMMIT: "c0ffee", NODE_ENV: "production" };

    const worker = await start(env, log, connect);
    expect(connect).toHaveBeenCalledWith("postgres://x@h/db");
    expect(lines).toEqual([{ service: "worker", msg: "worker ready", commit: "c0ffee" }]);

    await Promise.all([worker.stop("SIGTERM"), worker.stop("SIGTERM")]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lines.slice(1)).toEqual([
      { service: "worker", msg: "worker stopping", commit: "c0ffee", signal: "SIGTERM" },
      { service: "worker", msg: "worker stopped", commit: "c0ffee" },
    ]);
  });

  it("refuses to start in production without DATABASE_URL", async () => {
    const connect = vi.fn<Connect>();
    await expect(start({ NODE_ENV: "production" }, () => undefined, connect)).rejects.toThrow(
      "DATABASE_URL is required in production",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("logs nothing when the connection fails", async () => {
    const { lines, log } = collect();
    const connect: Connect = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(start({}, log, connect)).rejects.toThrow("ECONNREFUSED");
    expect(lines).toEqual([]);
  });
});
