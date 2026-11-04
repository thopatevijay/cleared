// M4-06: every consumer keeps fetching while its queue has a backlog (burst mode), so a slot isn't limited
// to one job per poll interval; the concurrency and poll stay as architecture §12 sets them.
// M5-PERF: while LISTEN/NOTIFY is up an idle consumer only polls as a backstop; dead-letter and cron
// consumers poll slowly with one slot.
import { describe, expect, it } from "vitest";
import { SCENARIO_POLL_QUEUE } from "@cleared/db";
import {
  BURST_WHEN_READY_EXCEEDS,
  CONCURRENCY,
  deadLetterWorkOptions,
  POLLING_INTERVAL_SECONDS,
  workOptions,
} from "../src/boss.ts";
import {
  CRON_POLLING_INTERVAL_SECONDS,
  cronWorkOptions,
  DLQ_POLLING_INTERVAL_SECONDS,
  NOTIFY_POLLING_INTERVAL_SECONDS,
} from "../src/poll-intervals.ts";

describe("worker consume options (M4-06)", () => {
  it("bursts while jobs are ready, at the §12 concurrency and poll", () => {
    const o = workOptions({}, "paypal.capture.sync");
    expect(o.burstWhenReadyExceeds).toBe(BURST_WHEN_READY_EXCEEDS);
    expect(BURST_WHEN_READY_EXCEEDS).toBe(1);
    expect(o.localConcurrency).toBe(CONCURRENCY);
    expect(o.batchSize).toBe(1);
    expect(o.pollingIntervalSeconds).toBe(POLLING_INTERVAL_SECONDS);
    expect(POLLING_INTERVAL_SECONDS).toBe(2);
  });
});

describe("idle polling (M5-PERF)", () => {
  it("polls a notify-enabled queue only every 30 s as a backstop, scenario.poll every 10 s", () => {
    expect(workOptions({}, "paypal.capture.sync").notifyPollingIntervalSeconds).toBe(
      NOTIFY_POLLING_INTERVAL_SECONDS,
    );
    expect(NOTIFY_POLLING_INTERVAL_SECONDS).toBe(30);
    expect(workOptions({}, SCENARIO_POLL_QUEUE).notifyPollingIntervalSeconds).toBe(10);
  });

  it("never sets the backstop below the fallback poll (pg-boss asserts it)", () => {
    for (const q of ["paypal.capture.sync", SCENARIO_POLL_QUEUE, ""]) {
      const o = workOptions({}, q);
      expect(o.notifyPollingIntervalSeconds).toBeGreaterThanOrEqual(o.pollingIntervalSeconds);
    }
  });

  it("runs a dead-letter consumer with one slot, polled once a minute", () => {
    const o = deadLetterWorkOptions({});
    expect(o).toMatchObject({ localConcurrency: 1, batchSize: 1, includeMetadata: true });
    expect(o.pollingIntervalSeconds).toBe(DLQ_POLLING_INTERVAL_SECONDS);
    expect(DLQ_POLLING_INTERVAL_SECONDS).toBe(60);
  });

  it("polls cron queues every 30 s", () => {
    expect(cronWorkOptions({})).toEqual({ pollingIntervalSeconds: CRON_POLLING_INTERVAL_SECONDS });
    expect(CRON_POLLING_INTERVAL_SECONDS).toBe(30);
  });

  it("uses the one fixed interval tests pass for every consumer kind", () => {
    const fixed = { pollingIntervalSeconds: 0.5 };
    expect(workOptions(fixed, SCENARIO_POLL_QUEUE)).toMatchObject({
      pollingIntervalSeconds: 0.5,
      notifyPollingIntervalSeconds: 0.5,
    });
    expect(deadLetterWorkOptions(fixed).pollingIntervalSeconds).toBe(0.5);
    expect(cronWorkOptions(fixed).pollingIntervalSeconds).toBe(0.5);
  });
});
