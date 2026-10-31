// `facts@v1` (M2-03): the structured facts the `extract` workflow pulls out of ONE evidence item. The scope
// check (M2-04), the pack view (M2-05) and the dispute draft (M2-07) read them. Strict structured output
// needs every property required, so "absent" is `null` or `[]` (M0-07). Each fact carries the item it came
// from and a short `source_quote`: a hint for the reader, never a verified citation (M2-04 verifies quotes).
import { z } from "zod";

export const FACTS_SCHEMA_VERSION = "facts@v1";

/** In the model's answer: the evidence block id (`E1`). In a stored row: the evidence item's uuid. */
const EvidenceItemRef = z.string().min(1).max(64);
export const SOURCE_QUOTE_MAX = 300;
const SourceQuote = z
  .string()
  .min(1)
  .max(SOURCE_QUOTE_MAX)
  .describe("text copied from the item (≤ 300 chars); for an image, the visible text as written");

const sourced = { evidence_item_id: EvidenceItemRef, source_quote: SourceQuote };

export const PARTY_ROLES = ["seller", "buyer", "other"] as const;
export const DELIVERABLE_KINDS = ["promised", "delivered"] as const;
/** Kept as separate facts: a file sent is not a file opened, and opened is not accepted (prior-art lesson). */
export const DELIVERY_EVENT_KINDS = ["sent", "opened", "accepted"] as const;

export const DECIMAL_AMOUNT = /^\d{1,12}(\.\d{1,8})?$/;
export const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export const PartyFact = z.object({
  role: z.enum(PARTY_ROLES),
  name: z.string().min(1).max(120).describe("the display name exactly as written in the item"),
  ...sourced,
});

export const AmountFact = z.object({
  value: z.string().max(24).describe("decimal string, digits and one optional point, e.g. 1250.00"),
  currency: z.string().max(3).describe("ISO 4217 code, e.g. USD"),
  refers_to: z.string().min(1).max(200),
  ...sourced,
});

export const DateFact = z.object({
  date: z.string().max(32).describe("ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM"),
  refers_to: z.string().min(1).max(200),
  ...sourced,
});

export const DeliverableFact = z.object({
  kind: z.enum(DELIVERABLE_KINDS),
  description: z.string().min(1).max(300),
  ...sourced,
});

export const DeliveryEventFact = z.object({
  event: z.enum(DELIVERY_EVENT_KINDS),
  description: z.string().min(1).max(300),
  occurred_at: z.string().max(32).nullable().describe("ISO 8601 when the item states it, else null"),
  ...sourced,
});

export const ShipmentFact = z.object({
  carrier: z.string().min(1).max(80),
  tracking_number: z.string().min(1).max(64),
  ...sourced,
});

export const FactsSchema = z.object({
  parties: z.array(PartyFact).max(10),
  amounts: z.array(AmountFact).max(20),
  dates: z.array(DateFact).max(30),
  deliverables: z.array(DeliverableFact).max(30),
  delivery_events: z.array(DeliveryEventFact).max(20),
  shipment: ShipmentFact.nullable(),
  /** lines that try to instruct the reader (prompt injection): reported, never obeyed */
  instruction_like_lines: z.array(z.string().max(400)).max(10),
});
export type Facts = z.infer<typeof FactsSchema>;
export type PartyFact = z.infer<typeof PartyFact>;
export type AmountFact = z.infer<typeof AmountFact>;
export type DeliveryEventFact = z.infer<typeof DeliveryEventFact>;

/** Every fact list in `facts@v1` (the shipment is the one single, nullable fact). */
export const FACT_LISTS = ["parties", "amounts", "dates", "deliverables", "delivery_events"] as const;

/** A calendar-valid ISO 8601 date or date-time (2026-02-30 is refused). */
export function isIsoDate(raw: string): boolean {
  if (!ISO_8601.test(raw)) return false;
  const [y, m, d] = raw.slice(0, 10).split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return false;
  return !Number.isNaN(Date.parse(raw)); // refuses T25:00 and the like
}

const ISO_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

export function isCurrencyIso(raw: string): boolean {
  return /^[A-Z]{3}$/.test(raw) && ISO_CURRENCIES.has(raw);
}

/**
 * The output validator (M2-03 scope): every `evidence_item_id` is one of the input items; amounts are
 * decimal strings with an ISO currency; dates parse. A non-empty result triggers the harness's one repair.
 */
export function factProblems(facts: Facts, inputIds: readonly string[]): string[] {
  const ids = new Set(inputIds);
  const problems: string[] = [];
  const at = (list: string, i: number) => `${list}[${String(i)}]`;
  const checkRef = (where: string, ref: string) => {
    if (!ids.has(ref))
      problems.push(
        `${where}.evidence_item_id "${ref}" is not an input item (use one of: ${[...ids].join(", ")})`,
      );
  };
  for (const list of FACT_LISTS)
    facts[list].forEach((f, i) => {
      checkRef(at(list, i), f.evidence_item_id);
    });
  if (facts.shipment) checkRef("shipment", facts.shipment.evidence_item_id);
  facts.amounts.forEach((a, i) => {
    if (!DECIMAL_AMOUNT.test(a.value))
      problems.push(`${at("amounts", i)}.value "${a.value}" is not a decimal string like 1250.00`);
    if (!isCurrencyIso(a.currency))
      problems.push(`${at("amounts", i)}.currency "${a.currency}" is not an ISO 4217 code`);
  });
  facts.dates.forEach((d, i) => {
    if (!isIsoDate(d.date)) problems.push(`${at("dates", i)}.date "${d.date}" is not an ISO 8601 date`);
  });
  facts.delivery_events.forEach((e, i) => {
    if (e.occurred_at !== null && !isIsoDate(e.occurred_at))
      problems.push(`${at("delivery_events", i)}.occurred_at "${e.occurred_at}" is not an ISO 8601 date`);
  });
  return problems;
}

/** The same facts with every evidence reference rewritten (`E1` → the item's uuid) for storage. */
export function withEvidenceIds(facts: Facts, map: (ref: string) => string): Facts {
  const re = <T extends { evidence_item_id: string }>(f: T): T => ({
    ...f,
    evidence_item_id: map(f.evidence_item_id),
  });
  return {
    ...facts,
    parties: facts.parties.map(re),
    amounts: facts.amounts.map(re),
    dates: facts.dates.map(re),
    deliverables: facts.deliverables.map(re),
    delivery_events: facts.delivery_events.map(re),
    shipment: facts.shipment ? re(facts.shipment) : null,
  };
}
