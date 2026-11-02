import { describe, expect, it } from "vitest";
import {
  adviseRoute,
  API_CARRIERS,
  carrierCountry,
  carrierDisplayName,
  carrierTier,
  classifyCarrier,
  countryFromTimeZone,
  matchCarrier,
  SHIPPED_BY_DROPDOWN,
  TIER_SOURCES,
} from "./index.ts";

describe("carrier data files", () => {
  it("each file names its source, date and a count that matches its list", () => {
    expect(SHIPPED_BY_DROPDOWN.source.length).toBeGreaterThan(0);
    expect(SHIPPED_BY_DROPDOWN.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SHIPPED_BY_DROPDOWN.count).toBe(SHIPPED_BY_DROPDOWN.codes.length);
    expect(API_CARRIERS.source).toBe("https://developer.paypal.com/docs/tracking/reference/carriers/");
    expect(API_CARRIERS.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(API_CARRIERS.count).toBe(API_CARRIERS.carriers.length);
  });

  it("every dropdown code except OTHER is in the API list (the dropdown is a subset)", () => {
    const api = new Set(API_CARRIERS.carriers.map((c) => c.code));
    const missing = SHIPPED_BY_DROPDOWN.codes.filter((c) => c !== "OTHER" && !api.has(c));
    expect(missing).toEqual([]);
    expect(SHIPPED_BY_DROPDOWN.codes).toContain("OTHER");
  });

  it("no code is listed twice", () => {
    expect(new Set(API_CARRIERS.carriers.map((c) => c.code)).size).toBe(API_CARRIERS.count);
    expect(new Set(SHIPPED_BY_DROPDOWN.codes).size).toBe(SHIPPED_BY_DROPDOWN.count);
  });
});

describe("two-tier map", () => {
  it.each(["IND_DELHIVERY", "DTDC_IN", "EKART", "BLUEDART", "NIPOST_NG", "IDN_JNE", "TCS"])(
    "%s is approved",
    (code) => {
      expect(carrierTier(code)).toBe("approved");
    },
  );

  it.each([
    "INDIA_POST",
    "KENYA_POST",
    "NIGERIAN_POST",
    "GHANA_POST",
    "PAKISTAN_POST",
    "BANGLADESH_POST",
    "EGYPT_POST",
    "JTEXPRESS_PH",
    "SPX_PH",
  ])("%s is accepted", (code) => {
    expect(carrierTier(code)).toBe("accepted");
  });

  it("free text is other, and only up to 64 characters", () => {
    expect(carrierTier("OTHER", "Speed Post local office")).toBe("other");
    expect(carrierTier("OTHER", "x".repeat(64))).toBe("other");
    expect(carrierTier("OTHER", "x".repeat(65))).toBeNull();
    expect(carrierTier("OTHER", "  ")).toBeNull();
    expect(carrierTier("OTHER")).toBeNull();
  });

  it("a code PayPal does not list has no tier", () => {
    expect(carrierTier("NOT_A_CARRIER")).toBeNull();
  });

  it("each tier cites its list and date", () => {
    expect(classifyCarrier("IND_DELHIVERY")?.source).toBe(TIER_SOURCES.approved);
    expect(classifyCarrier("INDIA_POST")?.source).toBe(TIER_SOURCES.accepted);
    expect(classifyCarrier("OTHER", "Local courier")?.source).toBe(TIER_SOURCES.other);
    expect(TIER_SOURCES.approved.date).toBe(SHIPPED_BY_DROPDOWN.captured_at);
    expect(TIER_SOURCES.accepted.url).toBe(API_CARRIERS.source);
  });
});

describe("adviseRoute", () => {
  it('adviseRoute("IN", "INDIA_POST") flags it and returns approved IN alternatives', () => {
    const a = adviseRoute("IN", "INDIA_POST");
    expect(a.flagged).toBe(true);
    expect(a.chosen?.tier).toBe("accepted");
    expect(a.alternatives.slice(0, 4).map((c) => c.code)).toEqual([
      "IND_DELHIVERY",
      "DTDC_IN",
      "EKART",
      "BLUEDART",
    ]);
    expect(a.alternatives.every((c) => carrierTier(c.code) === "approved" && c.country === "IN")).toBe(true);
    expect(a.caveat).toBe("sandbox_us_list");
  });

  it.each([
    ["NG", "NIPOST_NG"],
    ["ID", "IDN_JNE"],
    ["PK", "TCS"],
  ])("%s → %s first", (country, code) => {
    expect(adviseRoute(country).alternatives[0]?.code).toBe(code);
  });

  it("an approved choice is not flagged and is not suggested to itself", () => {
    const a = adviseRoute("IN", "IND_DELHIVERY");
    expect(a.flagged).toBe(false);
    expect(a.alternatives.map((c) => c.code)).not.toContain("IND_DELHIVERY");
  });

  it("free text is flagged; the country falls back to the chosen carrier's", () => {
    expect(adviseRoute("IN", { code: "OTHER", nameOther: "Local courier" }).flagged).toBe(true);
    expect(adviseRoute(null, "KENYA_POST").country).toBe("KE");
    expect(adviseRoute(null).alternatives).toEqual([]);
  });
});

describe("matching a written carrier", () => {
  it.each([
    ["India Post", "INDIA_POST"],
    ["Delhivery", "IND_DELHIVERY"],
    ["Blue Dart", "BLUEDART"],
    ["ind_delhivery", "IND_DELHIVERY"],
    ["Kenya Post", "KENYA_POST"],
  ])("%s → %s", (written, code) => {
    expect(matchCarrier(written)).toEqual({ code });
  });

  it("unknown text stays free text, cut to 64", () => {
    expect(matchCarrier("Raju's bicycle courier")).toEqual({
      code: "OTHER",
      nameOther: "Raju's bicycle courier",
    });
    expect(matchCarrier("y".repeat(80)).nameOther).toHaveLength(64);
  });
});

describe("countries", () => {
  it("reads PayPal's country, then the code, then Cleared's overrides", () => {
    expect(carrierCountry("IND_DELHIVERY", "IND")).toBe("IN");
    expect(carrierCountry("IDN_JNE", "GLOBAL")).toBe("ID");
    expect(carrierCountry("SPX_PH", "GLOBAL")).toBe("PH");
    expect(carrierCountry("BLUEDART", "GLOBAL")).toBe("IN");
    expect(carrierCountry("DHL", "GLOBAL")).toBeNull();
    expect(countryFromTimeZone("Asia/Kolkata")).toBe("IN");
    expect(countryFromTimeZone("Europe/Paris")).toBeNull();
  });

  it("display names drop the web address", () => {
    expect(carrierDisplayName("EKART", "Ekart logistics (ekartlogistics.com)")).toBe("Ekart");
    expect(carrierDisplayName("IND_SHREEMARUTI", "Shree Maruti (shreemaruti.com)")).toBe("Shree Maruti");
    expect(carrierDisplayName("ZZ", "ARAMEX")).toBe("Aramex");
  });
});
