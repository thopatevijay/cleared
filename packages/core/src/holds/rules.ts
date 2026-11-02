// The cited hold rule table (M3-01, ADR 0017): versioned data, no I/O. Every row names where its words
// come from (`source.url`, the verbatim `source.quote`, `retrieved_at`). A release date is always an
// estimate computed from a row (`estimate(from)`), shown with the label "estimated" and its source, never
// as PayPal's promise. A row whose source gives no timeline has `estimate = () => null`.
// Sample rows (`sample: true`) explain holds the sandbox can't produce; `deriveHold` never returns one.
import { addMinutes, toEpochMs, fromEpochMs, type Instant } from "../time.ts";

/** Bump when a row's words, source or estimate change (M3-02 caches explanations per rule version). */
export const HOLD_RULES_VERSION = 1;

/** The only label an estimate is ever shown with. */
export const ESTIMATE_LABEL = "estimated";

export const HOLD_TYPES = ["review", "dispute", "goods", "service", "other", "sample"] as const;
export type HoldType = (typeof HOLD_TYPES)[number];

export interface RuleSource {
  readonly url: string;
  /** what the page is, in a few words ("PayPal transaction event codes") */
  readonly title: string;
  /** verbatim from the page */
  readonly quote: string;
  /** YYYY-MM-DD */
  readonly retrieved_at: string;
  /** how it was retrieved when that limits the claim */
  readonly note?: string;
}

export interface HoldEstimate {
  /** the estimated release */
  readonly at: Instant;
  /** a later bound the source also states, when it does */
  readonly upperBound: Instant | null;
  readonly label: typeof ESTIMATE_LABEL;
}

/** Advice is shown only when a cited source carries it (dashboard.md element 9). */
export interface RuleAdvice {
  readonly kind: "dont_ship";
  /** the source sentence that carries it, verbatim */
  readonly quote: string;
  /** index into `sources` of the source that carries it */
  readonly sourceIndex: number;
}

export type RuleAppliesTo =
  | { readonly kind: "reason"; readonly reasons: readonly string[] }
  | { readonly kind: "action"; readonly action: "add_tracking" | "mark_completed" }
  | { readonly kind: "sample" };

export interface HoldRule {
  readonly id: string;
  readonly version: number;
  readonly type: HoldType;
  readonly appliesTo: RuleAppliesTo;
  readonly sample: boolean;
  /** null: PayPal gives no timeline (or the release depends on something else, e.g. a dispute) */
  readonly estimate: (from: Instant) => HoldEstimate | null;
  /** the first source is the one shown by default */
  readonly sources: readonly [RuleSource, ...RuleSource[]];
  readonly advice: RuleAdvice | null;
}

const HOUR = 60;
const noEstimate = (): null => null;

/** `from` plus `days` Monday–Friday days (UTC), keeping the time of day. */
export function addBusinessDays(from: Instant, days: number): Instant {
  let ms = toEpochMs(from);
  let left = days;
  while (left > 0) {
    ms += 24 * 60 * 60 * 1000;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return fromEpochMs(ms);
}

const EVENT_CODES_URL = "https://developer.paypal.com/docs/transaction-search/transaction-event-codes/";
const ORDERS_SPEC_URL = "https://developer.paypal.com/docs/api/orders/v2/#definition-capture_status_details";
const HELP129_URL = "https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129";
const HELP848_URL =
  "https://www.paypal.com/us/cshelp/article/new-paypal-account-%E2%80%93-payments-on-hold-and-accessing-your-money-quicker-help848";
const SEARCH_NOTE = "quoted from a web search summary of the page (the page refuses automated fetches)";

const HOLD_PANEL_QUOTE =
  "We're taking a closer look at this payment. It's required for some payments and normally takes up to 3 business days. Don't ship until we tell you it's ok.";

/** Orders v2 (spec 2.36) `capture_status_details.reason` descriptions, verbatim. */
const SPEC_REASON_TEXT = {
  ECHECK: "The payer paid by an eCheck that has not yet cleared.",
  INTERNATIONAL_WITHDRAWAL:
    "Visit your online account. In your **Account Overview**, accept and deny this payment.",
  OTHER:
    "No additional specific reason can be provided. For more information about this captured payment, visit your account online or contact PayPal.",
  RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION:
    "The payee has not yet set up appropriate receiving preferences for their account. For more information about how to accept or deny this payment, visit your account online. This reason is typically offered in scenarios such as when the currency of the captured payment is different from the primary holding currency of the payee.",
  REFUNDED: "The captured funds were refunded.",
  TRANSACTION_APPROVED_AWAITING_FUNDING:
    "The payer must send the funds for this captured payment. This code generally appears for manual EFTs.",
  UNILATERAL: "The payee does not have a PayPal account.",
  VERIFICATION_REQUIRED: "The payee's PayPal account is not verified.",
  DECLINED_BY_RISK_FRAUD_FILTERS: "Risk Filter set by the payee failed for the transaction.",
} as const;

function specRow(reason: keyof typeof SPEC_REASON_TEXT): HoldRule {
  return {
    id: `reason_${reason}`,
    version: 1,
    type: "other",
    appliesTo: { kind: "reason", reasons: [reason] },
    sample: false,
    estimate: noEstimate,
    sources: [
      {
        url: ORDERS_SPEC_URL,
        title: `PayPal Orders API v2: capture_status_details.reason ${reason}`,
        quote: SPEC_REASON_TEXT[reason],
        retrieved_at: "2026-10-26",
      },
    ],
    advice: null,
  };
}

export const PAYMENT_REVIEW_RULE: HoldRule = {
  id: "payment_review",
  version: 1,
  type: "review",
  appliesTo: { kind: "reason", reasons: ["PENDING_REVIEW"] },
  sample: false,
  estimate: (from) => ({
    at: addMinutes(from, 24 * HOUR),
    upperBound: addBusinessDays(from, 3),
    label: ESTIMATE_LABEL,
  }),
  sources: [
    {
      url: EVENT_CODES_URL,
      title: "PayPal transaction event codes: T2105 Payment review hold",
      quote:
        "A payment review hold protects against unauthorized fraud loss and for seller protection. PayPal reviews the transaction for up to 24 hours.",
      retrieved_at: "2026-10-26",
    },
    {
      url: "https://www.sandbox.paypal.com/",
      title: "PayPal seller account, Holds panel (sandbox)",
      quote: HOLD_PANEL_QUOTE,
      retrieved_at: "2026-10-28",
      note: "seen in the sandbox seller account on a PENDING_REVIEW payment; the panel has no public URL",
    },
  ],
  advice: { kind: "dont_ship", quote: "Don't ship until we tell you it's ok.", sourceIndex: 1 },
};

export const DISPUTE_HOLD_RULE: HoldRule = {
  id: "dispute_hold",
  version: 1,
  type: "dispute",
  appliesTo: { kind: "reason", reasons: ["BUYER_COMPLAINT", "CHARGEBACK"] },
  sample: false,
  // released when the linked dispute resolves: no date; the dispute's reply deadline is shown instead
  estimate: noEstimate,
  sources: [
    {
      url: EVENT_CODES_URL,
      title: "PayPal transaction event codes: T1110 / T1111 dispute holds",
      quote:
        "T1110 Hold on balance for dispute investigation: Hold to cover possible chargeback. T1111 Cancellation of hold for dispute resolution: Cancellation of temporary hold to cover possible chargeback.",
      retrieved_at: "2026-10-26",
    },
  ],
  advice: null,
};

export const GOODS_DELIVERED_RULE: HoldRule = {
  id: "goods_delivered",
  version: 1,
  type: "goods",
  appliesTo: { kind: "action", action: "add_tracking" },
  sample: false,
  // from = the courier's delivery confirmation (M3-03)
  estimate: (from) => ({ at: addMinutes(from, 24 * HOUR), upperBound: null, label: ESTIMATE_LABEL }),
  sources: [
    {
      url: HELP129_URL,
      title: "PayPal Help Center: How can I release my payments on hold?",
      quote:
        "Use one of our approved shipping carriers, and we'll release the hold approximately 24 hours after the courier confirms delivery to the buyer's address.",
      retrieved_at: "2026-10-26",
      note: SEARCH_NOTE,
    },
  ],
  advice: null,
};

export const SERVICE_COMPLETED_RULE: HoldRule = {
  id: "service_completed",
  version: 1,
  type: "service",
  appliesTo: { kind: "action", action: "mark_completed" },
  sample: false,
  // from = when the seller confirms the order as Completed (M3-04)
  estimate: (from) => ({ at: addMinutes(from, 7 * 24 * HOUR), upperBound: null, label: ESTIMATE_LABEL }),
  sources: [
    {
      url: HELP129_URL,
      title: "PayPal Help Center: How can I release my payments on hold?",
      quote: "We'll release the hold 7 days after you confirm the order status as Completed.",
      retrieved_at: "2026-10-26",
      note: SEARCH_NOTE,
    },
  ],
  advice: null,
};

function sampleRow(id: string, source: RuleSource): HoldRule {
  return {
    id,
    version: 1,
    type: "sample",
    appliesTo: { kind: "sample" },
    sample: true,
    estimate: noEstimate,
    sources: [source],
    advice: null,
  };
}

const OTHER_RULE = specRow("OTHER");

export const SAMPLE_RULES: readonly HoldRule[] = [
  sampleRow("new_seller_21d", {
    url: HELP848_URL,
    title: "PayPal Help Center: New PayPal account, payments on hold",
    quote: "for up to 21 days",
    retrieved_at: "2026-10-26",
    note: SEARCH_NOTE,
  }),
  sampleRow("reserve", {
    url: EVENT_CODES_URL,
    title: "PayPal transaction event codes: T2103 Reserve hold",
    quote:
      "PayPal holds a percentage of funds for a set number of days as a condition for processing. This amount is part of your total balance and will not be available for withdrawal.",
    retrieved_at: "2026-10-26",
  }),
  sampleRow("limitation", {
    url: EVENT_CODES_URL,
    title: "PayPal transaction event codes: T2120 KYC hold",
    quote: 'Amount put on hold: merchant "know your customer" (KYC) is incomplete.',
    retrieved_at: "2026-10-26",
  }),
];

/** Every row, derived and sample. */
export const HOLD_RULES: readonly HoldRule[] = [
  PAYMENT_REVIEW_RULE,
  DISPUTE_HOLD_RULE,
  GOODS_DELIVERED_RULE,
  SERVICE_COMPLETED_RULE,
  specRow("ECHECK"),
  specRow("INTERNATIONAL_WITHDRAWAL"),
  OTHER_RULE,
  specRow("RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION"),
  specRow("REFUNDED"),
  specRow("TRANSACTION_APPROVED_AWAITING_FUNDING"),
  specRow("UNILATERAL"),
  specRow("VERIFICATION_REQUIRED"),
  specRow("DECLINED_BY_RISK_FRAUD_FILTERS"),
  ...SAMPLE_RULES,
];

/** The row for a rule id (the `holds.estimate_source` column), or null for an unknown id. */
export function holdRule(id: string): HoldRule | null {
  return HOLD_RULES.find((r) => r.id === id) ?? null;
}

/**
 * The derivable row for a capture `status_details.reason`. A reason PayPal adds later (not in the spec
 * table) falls back to the `OTHER` row, whose spec text says no specific reason can be given.
 */
export function ruleForReason(reason: string): HoldRule {
  const row = HOLD_RULES.find((r) => r.appliesTo.kind === "reason" && r.appliesTo.reasons.includes(reason));
  return row ?? OTHER_RULE;
}
