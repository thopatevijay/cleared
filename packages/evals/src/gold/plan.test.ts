import { describe, expect, it } from "vitest";
import { holdRule } from "@cleared/core";
import { allSlots, splitFor, SPLIT_SEED } from "./plan.ts";
import { COUNTRIES, CURRENCIES, LABELS, SET_SIZE, SETS } from "./schema.ts";

const slots = allSlots();
const of = (set: string) => slots.filter((s) => s.set === set);

describe("case plan (M4-01)", () => {
  it("has the exact count per set and unique ids", () => {
    for (const set of SETS) expect(of(set)).toHaveLength(SET_SIZE[set]);
    expect(new Set(slots.map((s) => s.id)).size).toBe(90);
  });

  it("targets every label in at least 8 scope items, with at least 5 injection items", () => {
    for (const l of LABELS) {
      expect(of("scope").filter((s) => s.targets.some((t) => t.label === l)).length).toBeGreaterThanOrEqual(8);
    }
    expect(slots.filter((s) => s.injection).length).toBeGreaterThanOrEqual(5);
  });

  it("spreads countries, currencies, goods/services and Hinglish", () => {
    expect(new Set(slots.map((s) => s.persona.country))).toEqual(new Set(COUNTRIES));
    expect(new Set(slots.map((s) => s.persona.currency))).toEqual(new Set(CURRENCIES));
    expect(new Set(slots.map((s) => s.persona.offering))).toEqual(new Set(["goods", "services"]));
    expect(slots.filter((s) => s.tags.includes("hinglish")).length).toBeGreaterThan(0);
  });

  it("pairs 10 EN with 10 HI hold cases on known rule rows, sharing a split", () => {
    const holds = of("holds");
    expect(holds.filter((s) => s.locale === "en")).toHaveLength(10);
    expect(holds.filter((s) => s.locale === "hi")).toHaveLength(10);
    for (const s of holds) {
      expect(holdRule(s.hold?.expected_rule_id ?? "")).not.toBeNull();
      expect(s.splitKey).toBe(s.hold?.pair_id);
    }
    const reasons = new Set(holds.map((s) => s.hold?.capture_reason));
    expect(reasons).toContain("PENDING_REVIEW");
    expect(reasons).toContain("BUYER_COMPLAINT");
    expect(holds.filter((s) => s.hold?.sample).length).toBeGreaterThan(0);
  });

  it("splits about 25% dev by a seeded hash, deterministically", () => {
    expect(SPLIT_SEED).toBe("cleared-gold-v4");
    expect(splitFor("ext-001")).toBe(splitFor("ext-001"));
    for (const set of SETS) {
      const keys = [...new Set(of(set).map((s) => s.splitKey))];
      const dev = keys.filter((k) => splitFor(k) === "dev").length / keys.length;
      expect(Math.abs(dev - 0.25)).toBeLessThanOrEqual(0.05);
    }
  });

  it("holds documents quote the rule row verbatim", () => {
    const s = of("holds")[0];
    const rule = holdRule(s?.hold?.expected_rule_id ?? "");
    const quotes = s?.docs.filter((d) => d.kind === "paypal_rule").map((d) => d.fixedText);
    expect(quotes).toEqual(rule?.sources.map((src) => src.quote));
  });
});
