// BL-01 6649565560: the per-IP demo cap is a rolling 24 h window; the next slot frees when the oldest
// counted workspace ages out, and the 429 says when.
import { describe, expect, it } from "vitest";
import { nextSlotAt } from "../../src/server/caps.ts";

const DAY = 24 * 3600 * 1000;
const at = (iso: string): Date => new Date(iso);

describe("nextSlotAt", () => {
  it("3 of 3 used: the oldest + 24 h", () => {
    const times = [at("2026-11-04T09:37:00Z"), at("2026-11-04T10:52:00Z"), at("2026-11-04T13:59:00Z")];
    expect(nextSlotAt(times, 3, DAY)?.toISOString()).toBe("2026-11-05T09:37:00.000Z");
  });

  it("over the limit (a lowered cap): the slot frees when enough have aged out", () => {
    const times = [at("2026-11-04T01:00:00Z"), at("2026-11-04T02:00:00Z"), at("2026-11-04T03:00:00Z")];
    expect(nextSlotAt(times, 2, DAY)?.toISOString()).toBe("2026-11-05T02:00:00.000Z");
  });

  it("under the limit, or a limit below 1: null", () => {
    expect(nextSlotAt([at("2026-11-04T01:00:00Z")], 3, DAY)).toBeNull();
    expect(nextSlotAt([at("2026-11-04T01:00:00Z")], 0, DAY)).toBeNull();
  });
});
