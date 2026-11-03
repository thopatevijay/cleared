// M4-06: every consumer keeps fetching while its queue has a backlog (burst mode), so a slot isn't limited
// to one job per poll interval; the concurrency and poll stay as architecture §12 sets them.
import { describe, expect, it } from "vitest";
import { BURST_WHEN_READY_EXCEEDS, CONCURRENCY, POLLING_INTERVAL_SECONDS, workOptions } from "../src/boss.ts";

describe("worker consume options (M4-06)", () => {
  it("bursts while jobs are ready, at the §12 concurrency and poll", () => {
    const o = workOptions({});
    expect(o.burstWhenReadyExceeds).toBe(BURST_WHEN_READY_EXCEEDS);
    expect(BURST_WHEN_READY_EXCEEDS).toBe(1);
    expect(o.localConcurrency).toBe(CONCURRENCY);
    expect(o.batchSize).toBe(1);
    expect(o.pollingIntervalSeconds).toBe(POLLING_INTERVAL_SECONDS);
  });
});
