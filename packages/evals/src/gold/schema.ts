// M4-01 gold sets (ContractNLI-style): one item = documents + hypotheses, each hypothesis labelled
// met | partial | missing | unverifiable with verbatim spans. One scheme for all three sets; M4-02 reads
// these schemas to score the workflows. All personal data is synthetic (PROJECT.md §9.1).
import { EVIDENCE_KINDS, LOCALES, parseAgentConfig } from "@cleared/core";
import { z } from "zod";

export const SETS = ["extraction", "scope", "holds"] as const;
export type GoldSet = (typeof SETS)[number];

/** The exact item count per set (AC 1). */
export const SET_SIZE: Readonly<Record<GoldSet, number>> = { extraction: 30, scope: 40, holds: 20 };

export const LABELS = ["met", "partial", "missing", "unverifiable"] as const;
export type Label = z.infer<typeof LabelSchema>;
export const LabelSchema = z.enum(LABELS);

/**
 * Document kinds: the `evidence_items.kind` values, plus two for the holds set only, whose input is
 * PayPal's own data rather than seller evidence: the capture and the rule row's verbatim source quote.
 */
export const HOLD_DOC_KINDS = ["paypal_capture", "paypal_rule"] as const;
export const DOC_KINDS = [...EVIDENCE_KINDS, ...HOLD_DOC_KINDS] as const;
export const DocKindSchema = z.enum(DOC_KINDS);

/** Extraction facts: amount and currency, deliverables, dates, parties, tracking number and carrier. */
export const FACT_FIELDS = ["amount", "deliverable", "date", "party", "tracking_number", "carrier"] as const;
export const FactFieldSchema = z.enum(FACT_FIELDS);

/** What a hold explanation must never claim, stored as codes (no claim text in the data). */
export const FORBIDDEN_CLAIMS = ["guaranteed_release", "seller_won", "exact_release_date"] as const;
export const ForbiddenClaimSchema = z.enum(FORBIDDEN_CLAIMS);

export const COUNTRIES = ["IN", "KE", "NG", "ID", "PH"] as const;
export const CURRENCIES = ["USD", "EUR", "INR", "JPY"] as const;

const DEFAULT_MODELS = parseAgentConfig({}).models;

/** The model each workflow under test runs in production (extract.ts, scope-check.ts, explain-hold.ts). */
export const PROD_MODEL: Readonly<Record<GoldSet, string>> = {
  extraction: DEFAULT_MODELS.small,
  scope: DEFAULT_MODELS.large,
  holds: DEFAULT_MODELS.small,
};

/** The second-model reviewer per set: never the production model for that task (AC 3). */
export const REVIEW_MODEL: Readonly<Record<GoldSet, string>> = {
  extraction: DEFAULT_MODELS.large,
  scope: "gpt-5.4-mini-2026-03-17",
  holds: DEFAULT_MODELS.large,
};

export const SpanSchema = z.object({
  doc_id: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1),
});
export type Span = z.infer<typeof SpanSchema>;

export const DocumentSchema = z.object({
  doc_id: z.string().regex(/^D\d+$/),
  kind: DocKindSchema,
  title: z.string().min(1),
  text: z.string().min(1),
});
export type GoldDocument = z.infer<typeof DocumentSchema>;

export const PersonaSchema = z.object({
  country: z.enum(COUNTRIES),
  trade: z.string().min(1),
  offering: z.enum(["goods", "services"]),
  currency: z.enum(CURRENCIES),
});

/** A hypothesis as drafted: what to label. `intended_label` is the generator's target, hidden from labellers. */
export const DraftHypothesisSchema = z.object({
  h_id: z.string().regex(/^H\d+$/),
  text: z.string().min(1),
  intended_label: LabelSchema,
  /** extraction only: the fact kind and its expected value */
  field: FactFieldSchema.nullable(),
  value: z.string().nullable(),
  /** holds only: the same code on the EN and HI item of a pair (fact parity, BL-01 6570430484) */
  fact_code: z.string().regex(/^[a-z_]+$/).nullable(),
});

export const HoldCaseSchema = z.object({
  pair_id: z.string().regex(/^hold-\d{2}$/),
  capture_reason: z.string().min(1),
  /** a badged sample scenario (rules.ts SAMPLE_RULES), not derived from the reason */
  sample: z.boolean(),
  /** the rule-table row (M3-01) the explanation must use */
  expected_rule_id: z.string().min(1),
  forbidden_claims: z.array(ForbiddenClaimSchema).min(1),
});
export type HoldCase = z.infer<typeof HoldCaseSchema>;

export const DraftItemSchema = z.object({
  id: z.string().regex(/^(ext-\d{3}|scope-\d{3}|hold-\d{2}-(en|hi))$/),
  set: z.enum(SETS),
  split: z.enum(["dev", "test"]),
  locale: z.enum(LOCALES),
  persona: PersonaSchema,
  /** e.g. `hinglish` */
  tags: z.array(z.string().min(1)),
  /** buyer-written evidence carries injection text; labelled as if it were absent (M4-02 reuses these) */
  injection: z.boolean(),
  documents: z.array(DocumentSchema).min(1),
  hypotheses: z.array(DraftHypothesisSchema).min(1),
  hold: HoldCaseSchema.nullable(),
  drafted_by: z.object({ model: z.string().min(1), prompt_version: z.string().min(1) }),
});
export type DraftItem = z.infer<typeof DraftItemSchema>;
export type DraftHypothesis = z.infer<typeof DraftHypothesisSchema>;

export const ReviewLabelSchema = z.object({
  h_id: z.string(),
  label: LabelSchema,
  spans: z.array(SpanSchema),
  /** reviewer quotes that are not verbatim in the cited document (dropped from `spans`) */
  unmatched_quotes: z.number().int().nonnegative(),
});
export const ReviewSchema = z.object({
  item_id: z.string(),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  labels: z.array(ReviewLabelSchema),
});
export type Review = z.infer<typeof ReviewSchema>;

export const GoldHypothesisSchema = DraftHypothesisSchema.extend({
  label: LabelSchema,
  spans: z.array(SpanSchema),
  note: z.string(),
});
export type GoldHypothesis = z.infer<typeof GoldHypothesisSchema>;

export const GoldItemSchema = DraftItemSchema.extend({
  hypotheses: z.array(GoldHypothesisSchema).min(1),
  labelled_by: z.literal("owner"),
  /** embedded by `eval:label --reconcile`; null until then (validate fails on null) */
  review: ReviewSchema.nullable(),
});
export type GoldItem = z.infer<typeof GoldItemSchema>;

export const DisagreementSchema = z.object({
  set: z.enum(SETS),
  item_id: z.string(),
  h_id: z.string(),
  owner_label: LabelSchema,
  model_label: LabelSchema,
  model: z.string(),
  final: LabelSchema,
  reason: z.string().min(1),
});
export type Disagreement = z.infer<typeof DisagreementSchema>;
