// BL-01 6603617791 (owner decision 2026-11-04, option a): the reconcile poll's tiered cadence.
// PENDING captures every tick; a settled (recently changed) capture once an hour, so a missed refund
// webhook on a COMPLETED capture is still caught within 1 h.
import { describe, expect, it } from "vitest";
import { BUCKET_MS, capturesDue, TICKS_PER_HOUR } from "./reconcile.ts";

const settled = Array.from({ length: 200 }, (_, i) => ({ captureId: `C${String(i)}`, status: "COMPLETED" }));
const pending = [
  { captureId: "P1", status: "PENDING" },
  { captureId: "P2", status: "PENDING" },
];
const HOUR_TICKS = (60 * 60_000) / BUCKET_MS;

describe("reconcile tiered cadence", () => {
  it("ticks per hour matches the 15-minute bucket", () => {
    expect(TICKS_PER_HOUR).toBe(HOUR_TICKS);
  });

  it("enqueues PENDING captures on every tick", () => {
    for (let tick = 0; tick < 3 * HOUR_TICKS; tick += 1) {
      const ids = capturesDue([...pending, ...settled], tick).map((c) => c.captureId);
      expect(ids).toEqual(expect.arrayContaining(["P1", "P2"]));
    }
  });

  it("catches a missed refund on a COMPLETED capture within 1 h of ticks, and checks it once an hour", () => {
    const start = 1_234_567; // an arbitrary tick index
    for (const c of settled) {
      const hits: number[] = [];
      for (let k = 0; k < 2 * HOUR_TICKS; k += 1) {
        if (capturesDue([c], start + k).length > 0) hits.push(k);
      }
      expect(hits).toHaveLength(2); // once per hour
      expect(hits[0]).toBeLessThan(HOUR_TICKS); // enqueued within 1 h of the first tick
      expect((hits[1] ?? 0) - (hits[0] ?? 0)).toBe(HOUR_TICKS);
    }
  });

  it("spreads settled captures over the four ticks (about a quarter per tick)", () => {
    for (let tick = 0; tick < HOUR_TICKS; tick += 1) {
      const n = capturesDue(settled, tick).length;
      expect(n).toBeGreaterThan(20);
      expect(n).toBeLessThan(80);
    }
  });
});
