import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api.ts";
import { demoCapFrom } from "./demo-cap.ts";

const res = (details: unknown, retryAfter: number | null): ApiResult => ({
  status: 429,
  body: { error: { code: "rate_limited", message: "m", details, correlationId: "c1" } },
  correlationId: "c1",
  retryAfter,
});

describe("demoCapFrom (BL-01 6649565560)", () => {
  it("the per-network cap: limit and the time the next slot frees, from details", () => {
    const cap = demoCapFrom(
      res({ cap: "demo_per_ip", limit: 3, windowHours: 24, retryAt: "2026-11-05T09:37:00.000Z" }, 19_320),
    );
    expect(cap).toEqual({ perIp: true, limit: 3, retryAt: "2026-11-05T09:37:00.000Z", minutes: 322, ref: "c1" });
  });

  it("the global cap is not the per-network one, even with a long Retry-After", () => {
    expect(demoCapFrom(res({ cap: "demo_global" }, 3600)).perIp).toBe(false);
  });

  it("no or bad timestamp → null (never computed from Retry-After alone)", () => {
    expect(demoCapFrom(res({ cap: "demo_per_ip", retryAt: "soon" }, 86_400)).retryAt).toBeNull();
    expect(demoCapFrom(res(null, 86_400))).toMatchObject({ perIp: true, limit: 3, retryAt: null });
  });
});
