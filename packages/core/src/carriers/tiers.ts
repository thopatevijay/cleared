// The two-tier carrier map (M3-03), from two recorded lists (no I/O; the JSON ships with the package):
// - `approved`: in the "Shipped by" dropdown of Add tracking info (PayPal support's meaning of "approved
//   shipping carriers" in help129): faster release expected, about 24 h after delivery is confirmed;
// - `accepted`: in PayPal's tracking API carrier list only: PayPal accepts it; it may not speed up the release;
// - `other`: `OTHER` with a free-text `carrier_name_other` (≤ 64 chars): the same as `accepted`, unconfirmed.
// Every tier cites its list and date. The dropdown is a sandbox US account's list; live and other-country
// accounts may differ (the caveat is always shown with a tier).
import { z } from "zod";
import apiData from "../../data/carriers/api-carriers.json" with { type: "json" };
import dropdownData from "../../data/carriers/shipped-by-dropdown.json" with { type: "json" };
import { carrierCountry } from "./countries.ts";

export const CARRIER_TIERS = ["approved", "accepted", "other"] as const;
export type CarrierTier = (typeof CARRIER_TIERS)[number];

/** PayPal's free-text carrier, with `carrier: "OTHER"` (Orders v2 track: max 64). */
export const OTHER_CARRIER = "OTHER";
export const CARRIER_NAME_OTHER_MAX = 64;

const ApiCarriersSchema = z.object({
  source: z.url(),
  retrieved_at: z.iso.date(),
  /** M3-03 AC 1: codes not on the developer page, each proven by its own source (see PROVENANCE.md) */
  additional_sources: z
    .array(z.object({ id: z.string().min(1), title: z.string().min(1), date: z.iso.date(), evidence: z.string().min(1) }))
    .default([]),
  count: z.number().int().positive(),
  carriers: z
    .array(
      z.object({
        code: z.string().regex(/^[A-Z0-9_]+$/),
        name: z.string().min(1),
        country: z.string(),
        /** absent: on the developer page; else an `additional_sources` id */
        source: z.string().min(1).optional(),
        /** PayPal's debug id of the call that proved the code (with `source`) */
        debug_id: z.string().regex(/^[a-z0-9]+$/).optional(),
      }),
    )
    .min(1),
});

const DropdownSchema = z.object({
  source: z.string().min(1),
  captured_at: z.iso.date(),
  account: z.string().min(1),
  count: z.number().int().positive(),
  codes: z.array(z.string().regex(/^[A-Z0-9_]+$/)).min(1),
});

/** Parsed once at load: a malformed data file fails every import, never a silent empty map. */
export const API_CARRIERS = ApiCarriersSchema.parse(apiData);
export const SHIPPED_BY_DROPDOWN = DropdownSchema.parse(dropdownData);

export interface Carrier {
  readonly code: string;
  /** PayPal's name for it (API list) */
  readonly name: string;
  /** ISO alpha-2, or null (see countries.ts) */
  readonly country: string | null;
}

export interface TierSource {
  readonly title: string;
  /** null for the dropdown: it is a page behind a sandbox login */
  readonly url: string | null;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly note?: string;
}

const CARRIERS: ReadonlyMap<string, Carrier> = new Map(
  API_CARRIERS.carriers.map((c) => [
    c.code,
    { code: c.code, name: c.name, country: carrierCountry(c.code, c.country) },
  ]),
);
const DROPDOWN: ReadonlySet<string> = new Set(SHIPPED_BY_DROPDOWN.codes);

const API_SOURCE: TierSource = {
  title: "PayPal tracking API: carriers",
  url: API_CARRIERS.source,
  date: API_CARRIERS.retrieved_at,
};

export const TIER_SOURCES: Readonly<Record<CarrierTier, TierSource>> = {
  approved: {
    title: `PayPal "Shipped by" list in Add tracking info (${SHIPPED_BY_DROPDOWN.account})`,
    url: null,
    date: SHIPPED_BY_DROPDOWN.captured_at,
  },
  accepted: API_SOURCE,
  other: API_SOURCE,
};

export function carrierByCode(code: string): Carrier | null {
  return CARRIERS.get(code) ?? null;
}

/** Every carrier in the dropdown (approved), in PayPal's API-list order. */
export function approvedCarriers(): Carrier[] {
  return [...CARRIERS.values()].filter((c) => c.code !== OTHER_CARRIER && DROPDOWN.has(c.code));
}

export interface ClassifiedCarrier {
  readonly tier: CarrierTier;
  /** the PayPal code; `OTHER` for free text */
  readonly code: string;
  /** PayPal's name, or the seller's free text */
  readonly name: string;
  readonly country: string | null;
  readonly source: TierSource;
}

/**
 * The tier of a PayPal carrier code, or of `OTHER` + free text. null when the code is not in PayPal's API
 * list (PayPal would refuse it) or the free text is empty or too long.
 */
export function classifyCarrier(code: string, nameOther?: string): ClassifiedCarrier | null {
  if (code === OTHER_CARRIER) {
    const name = nameOther?.trim() ?? "";
    if (name.length === 0 || name.length > CARRIER_NAME_OTHER_MAX) return null;
    return { tier: "other", code, name, country: null, source: TIER_SOURCES.other };
  }
  const c = CARRIERS.get(code);
  if (c === undefined) return null;
  const tier: CarrierTier = DROPDOWN.has(code) ? "approved" : "accepted";
  return { tier, code, name: c.name, country: c.country, source: TIER_SOURCES[tier] };
}

export function carrierTier(code: string, nameOther?: string): CarrierTier | null {
  return classifyCarrier(code, nameOther)?.tier ?? null;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const squash = (s: string): string => norm(s).replace(/ /g, "");

/**
 * The PayPal code for a carrier as a person writes it (a shipment fact's "India Post", "Blue Dart",
 * "IND_DELHIVERY"): the code itself, an exact name, or the shortest name that starts with it. Free text
 * that matches nothing stays free text (`OTHER`).
 */
export function matchCarrier(written: string): { code: string; nameOther?: string } {
  const text = written.trim();
  const upper = text.toUpperCase();
  if (upper !== OTHER_CARRIER && CARRIERS.has(upper)) return { code: upper };
  const n = norm(text);
  const s = squash(text);
  if (n.length > 0) {
    const all = [...CARRIERS.values()].filter((c) => c.code !== OTHER_CARRIER);
    const exact = all.find((c) => norm(c.name) === n || squash(c.name) === s);
    if (exact !== undefined) return { code: exact.code };
    const starts = all
      .filter((c) => norm(c.name).startsWith(`${n} `))
      .sort((a, b) => a.name.length - b.name.length)[0];
    if (starts !== undefined) return { code: starts.code };
  }
  return { code: OTHER_CARRIER, nameOther: text.slice(0, CARRIER_NAME_OTHER_MAX) };
}
