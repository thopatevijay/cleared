import { describe, expect, it } from "vitest";
import { run } from "./main.ts";

describe("worker entry", () => {
  it("logs one JSON line and exits 0 in --dry-run", () => {
    const lines: Record<string, unknown>[] = [];
    const code = run(["--dry-run"], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toEqual([{ service: "worker", msg: "dry run: nothing to consume", dryRun: true }]);
  });
});
