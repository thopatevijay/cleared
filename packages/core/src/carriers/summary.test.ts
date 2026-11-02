import { describe, expect, it } from "vitest";
import { TrackingSummarySchema, trackingSummary, type TrackingInputs } from "./summary.ts";

const base: TrackingInputs = { holdState: "open", action: null, shipment: null, timeZone: "Asia/Kolkata" };
const payload = {
  order_id: "2KC08730ML031160C",
  capture_id: "6BC19320SY177903T",
  carrier: "IND_DELHIVERY",
  tracking_number: "SPKA1793249841084",
  notify_payer: false,
};

describe("trackingSummary (M3-03)", () => {
  it("India Post in the shipment evidence: flagged, approved IN alternatives, prefilled", () => {
    const s = trackingSummary({
      ...base,
      shipment: { carrier: "India Post", tracking_number: "EE 123 456 789 IN" },
    });
    expect(TrackingSummarySchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({
      state: "none",
      chosen: { code: "INDIA_POST", tier: "accepted" },
      country: "IN",
      flagged: true,
      prefill: { carrier: "INDIA_POST", tracking_number: "EE123456789IN" },
    });
    expect(s.alternatives.slice(0, 4).map((a) => a.code)).toEqual([
      "IND_DELHIVERY",
      "DTDC_IN",
      "EKART",
      "BLUEDART",
    ]);
  });

  it("an approved carrier is not flagged", () => {
    const s = trackingSummary({ ...base, shipment: { carrier: "Delhivery", tracking_number: "D1" } });
    expect(s.flagged).toBe(false);
    expect(s.chosen?.tier).toBe("approved");
  });

  it("no carrier yet: a prevention nudge (alternatives) with nothing flagged", () => {
    const s = trackingSummary(base);
    expect(s.chosen).toBeNull();
    expect(s.flagged).toBe(false);
    expect(s.alternatives.length).toBeGreaterThan(0);
  });

  it("free text stays other and flagged; the action's payload wins over the evidence", () => {
    const other = trackingSummary({ ...base, shipment: { carrier: "Raju courier", tracking_number: "R1" } });
    expect(other.chosen).toMatchObject({ code: "OTHER", name: "Raju courier", tier: "other" });
    expect(other.flagged).toBe(true);
    const s = trackingSummary({
      ...base,
      shipment: { carrier: "India Post", tracking_number: "X" },
      action: { id: "3f0c6f3e-0000-4000-8000-000000000001", state: "proposed", payload },
    });
    expect(s).toMatchObject({ state: "proposed", chosen: { code: "IND_DELHIVERY" }, flagged: false });
  });

  it.each([
    ["approved", "filing"],
    ["executing", "filing"],
    ["unknown", "filing"],
    ["failed", "failed"],
    ["succeeded", "filed"],
    ["rejected", "none"],
  ] as const)("action %s → %s", (state, want) => {
    const action = { id: "3f0c6f3e-0000-4000-8000-000000000001", state, payload };
    expect(trackingSummary({ ...base, action }).state).toBe(want);
  });

  it("a filed hold is filed whatever the action says", () => {
    expect(trackingSummary({ ...base, holdState: "filed" }).state).toBe("filed");
  });
});
