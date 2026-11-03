import { describe, expect, it } from "vitest";
import {
  DEMO_WORKSPACE_EXPIRES_AT,
  demoExpiresAt,
  isPurgeDue,
  parseInstant,
  purgeAt,
  retentionOf,
  type Instant,
  type RetentionSubject,
} from "../src/index.ts";

function instant(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const demo = (created: string): RetentionSubject => {
  const createdAt = instant(created);
  return { kind: "demo", createdAt, expiresAt: demoExpiresAt(createdAt) };
};

describe("retention policy (M4-07)", () => {
  it("a demo workspace created 2026-11-20 expires 2026-12-16 and is purged 2026-12-22", () => {
    const ws = demo("2026-11-20T09:30:00Z");
    expect(retentionOf(ws)).toEqual({
      expiresAt: "2026-12-16T00:00:00.000Z",
      purgeAt: "2026-12-22T00:00:00.000Z",
    });
    expect(isPurgeDue(ws, instant("2026-12-21T23:59:59.999Z"))).toBe(false);
    expect(isPurgeDue(ws, instant("2026-12-22T00:00:00Z"))).toBe(true);
    expect(isPurgeDue(ws, instant("2026-12-22T00:01:00Z"))).toBe(true);
  });

  it("a demo workspace created 2026-12-20 expires 2026-12-27 (created + 7 days) and is purged 2027-01-02", () => {
    const ws = demo("2026-12-20T00:00:00Z");
    expect(ws.expiresAt).toBe("2026-12-27T00:00:00.000Z");
    expect(retentionOf(ws)?.purgeAt).toBe("2027-01-02T00:00:00.000Z");
    expect(isPurgeDue(ws, instant("2026-12-22T00:01:00Z"))).toBe(false);
  });

  it("the cohort boundary: created exactly at 2026-12-16 gets created + 7 days", () => {
    expect(demoExpiresAt(instant("2026-12-15T23:59:59.999Z"))).toBe(DEMO_WORKSPACE_EXPIRES_AT);
    expect(demoExpiresAt(instant("2026-12-16T00:00:00Z"))).toBe("2026-12-23T00:00:00.000Z");
  });

  it("a seller workspace is never purged", () => {
    const seller: RetentionSubject = {
      kind: "seller",
      createdAt: instant("2026-10-01T00:00:00Z"),
      expiresAt: null,
    };
    expect(retentionOf(seller)).toBeNull();
    expect(isPurgeDue(seller, instant("2030-01-01T00:00:00Z"))).toBe(false);
    // even with an expiry somehow set, a seller workspace stays
    expect(
      isPurgeDue({ ...seller, expiresAt: instant("2026-11-01T00:00:00Z") }, instant("2030-01-01T00:00:00Z")),
    ).toBe(false);
  });

  it("the stored expiry wins (a synthetic run's short expiry); a missing one falls back to the policy", () => {
    const createdAt = instant("2026-11-20T03:00:00Z");
    const synthetic: RetentionSubject = {
      kind: "demo",
      createdAt,
      expiresAt: instant("2026-11-20T04:00:00Z"),
    };
    expect(retentionOf(synthetic)?.purgeAt).toBe("2026-11-26T04:00:00.000Z");
    expect(retentionOf({ kind: "demo", createdAt, expiresAt: null })?.expiresAt).toBe(
      DEMO_WORKSPACE_EXPIRES_AT,
    );
    expect(purgeAt(DEMO_WORKSPACE_EXPIRES_AT)).toBe("2026-12-22T00:00:00.000Z");
  });
});
