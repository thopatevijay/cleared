// M3-10 review-hold pool rules: the capture outcome, the assignment refusals (AC 2) and the release estimate.
import { describe, expect, it } from "vitest";
import { addMinutes, type Instant } from "../time.ts";
import {
  poolAssignableSince,
  poolCaptureOutcome,
  poolCatalogueItem,
  poolExpectedRelease,
  poolRefusal,
  REVIEW_POOL_CATALOGUE,
  type PoolCandidate,
} from "./pool.ts";

const NOW = "2026-11-02T12:00:00.000Z" as Instant;
const POOL = "2d0b5e3a-7f4c-4a81-8c9d-2e3f4a5b6c7d";
const JUDGE = "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b";

const held: PoolCandidate = {
  state: "held",
  poolWorkspaceId: POOL,
  ownerWorkspaceId: POOL,
  assignedWorkspaceId: null,
  capturedAt: addMinutes(NOW, -60),
  mirrorStatus: "PENDING",
};

describe("poolCaptureOutcome", () => {
  it("only PENDING / PENDING_REVIEW is held", () => {
    expect(poolCaptureOutcome("PENDING", "PENDING_REVIEW")).toBe("held");
    expect(poolCaptureOutcome("COMPLETED", null)).toBe("not_held");
    expect(poolCaptureOutcome("PENDING", "UNILATERAL")).toBe("not_held");
    expect(poolCaptureOutcome("DECLINED", null)).toBe("not_held");
  });
});

describe("poolRefusal (AC 2)", () => {
  it("a fresh, pool-owned, held, unassigned row may be assigned", () => {
    expect(poolRefusal(held, NOW)).toBeNull();
    expect(poolRefusal({ ...held, mirrorStatus: null }, NOW)).toBeNull();
  });
  it("refuses a row the pool doesn't own", () => {
    expect(poolRefusal({ ...held, ownerWorkspaceId: JUDGE }, NOW)).toBe("not_pool_owned");
    expect(poolRefusal({ ...held, ownerWorkspaceId: null }, NOW)).toBe("not_pool_owned");
  });
  it("refuses a released row (pool state or the payments mirror)", () => {
    expect(poolRefusal({ ...held, state: "released" }, NOW)).toBe("released");
    expect(poolRefusal({ ...held, mirrorStatus: "COMPLETED" }, NOW)).toBe("released");
  });
  it("refuses a row 20 h old or older", () => {
    expect(poolRefusal({ ...held, capturedAt: addMinutes(NOW, -20 * 60) }, NOW)).toBe("too_old");
    expect(poolRefusal({ ...held, capturedAt: addMinutes(NOW, -20 * 60 + 1) }, NOW)).toBeNull();
    expect(poolAssignableSince(NOW)).toBe(addMinutes(NOW, -20 * 60));
  });
  it("refuses rows that aren't held or are already assigned", () => {
    expect(poolRefusal({ ...held, state: "awaiting_buyer", capturedAt: null }, NOW)).toBe("not_held");
    expect(poolRefusal({ ...held, state: "not_held" }, NOW)).toBe("not_held");
    expect(poolRefusal({ ...held, assignedWorkspaceId: JUDGE }, NOW)).toBe("already_assigned");
  });
});

describe("poolExpectedRelease", () => {
  it("is the payment_review estimate: about 24 h after capture", () => {
    const e = poolExpectedRelease(NOW);
    expect(e?.at).toBe(addMinutes(NOW, 24 * 60));
    expect(e?.label).toBe("estimated");
  });
});

describe("catalogue", () => {
  it("cycles through synthetic items priced in USD", () => {
    expect(poolCatalogueItem(0)).toBe(REVIEW_POOL_CATALOGUE[0]);
    expect(poolCatalogueItem(REVIEW_POOL_CATALOGUE.length)).toBe(REVIEW_POOL_CATALOGUE[0]);
    for (const i of REVIEW_POOL_CATALOGUE) expect(i.value).toMatch(/^\d+\.\d{2}$/);
  });
});
