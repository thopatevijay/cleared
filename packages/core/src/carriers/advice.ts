// Route advice (M3-03, pillar P5 prevention): before the seller ships or files tracking on a goods hold,
// name the approved carriers for their country and flag a chosen carrier that is only `accepted` or
// `other`. It never promises a release: approved means "faster release expected", PayPal decides.
import {
  approvedCarriers,
  classifyCarrier,
  TIER_SOURCES,
  type Carrier,
  type ClassifiedCarrier,
  type TierSource,
} from "./tiers.ts";

/** The carriers shown first for a country (Cleared's ordering of the approved list, not a tier). */
const FEATURED: Readonly<Record<string, readonly string[]>> = {
  IN: ["IND_DELHIVERY", "DTDC_IN", "EKART", "BLUEDART"],
  NG: ["NIPOST_NG"],
  ID: ["IDN_JNE"],
  PK: ["TCS"],
};

/** Shown with every tier and every piece of advice. */
export const CARRIER_CAVEAT = "sandbox_us_list" as const;

export interface RouteAdvice {
  /** ISO alpha-2 the alternatives are for; null when unknown (then there are none) */
  readonly country: string | null;
  readonly chosen: ClassifiedCarrier | null;
  /** the chosen carrier is `accepted` or `other`: suggest the alternatives */
  readonly flagged: boolean;
  /** approved carriers for the country, featured first; never the chosen one */
  readonly alternatives: readonly Carrier[];
  readonly sources: { readonly approved: TierSource; readonly accepted: TierSource };
  readonly caveat: typeof CARRIER_CAVEAT;
}

export interface ChosenCarrier {
  readonly code: string;
  readonly nameOther?: string;
}

export function approvedFor(country: string): Carrier[] {
  const featured = FEATURED[country] ?? [];
  const rank = (c: Carrier) => {
    const i = featured.indexOf(c.code);
    return i === -1 ? featured.length : i;
  };
  return approvedCarriers()
    .filter((c) => c.country === country)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * `adviseRoute("IN", "INDIA_POST")` → flagged, with Delhivery, DTDC, Ekart, Blue Dart first. The country
 * defaults to the chosen carrier's own when the caller has none.
 */
export function adviseRoute(country: string | null, chosen?: string | ChosenCarrier): RouteAdvice {
  const pick = typeof chosen === "string" ? { code: chosen } : chosen;
  const classified = pick === undefined ? null : classifyCarrier(pick.code, pick.nameOther);
  const where = country ?? classified?.country ?? null;
  const alternatives = where === null ? [] : approvedFor(where).filter((c) => c.code !== classified?.code);
  return {
    country: where,
    chosen: classified,
    flagged: classified !== null && classified.tier !== "approved",
    alternatives,
    sources: { approved: TIER_SOURCES.approved, accepted: TIER_SOURCES.accepted },
    caveat: CARRIER_CAVEAT,
  };
}

/** A carrier's name for people: PayPal's name without its parenthetical web address. */
export function carrierDisplayName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}
