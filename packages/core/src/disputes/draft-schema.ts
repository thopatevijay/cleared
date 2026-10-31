// `dispute_draft@v1` (M2-07): the model's answer for `draft_dispute@v1` and the input it is drafted from.
// Model I/O uses short refs, never uuids: `E<n>` pack items, `F<n>` extracted facts, `C<n>` scope lines,
// `Q<n>` verified quotes. Code maps them back. Strict structured outputs need every property required.
import { z } from "zod";
import { DISPUTE_NOTES_MAX_CHARS } from "./dispute.ts";
import type { FactFocus } from "./reason-map.ts";

export const DRAFT_SCHEMA_VERSION = "dispute_draft@v1";
/** At most this many items go into one compiled PDF (and its one-page cover index). */
export const DRAFT_MAX_SELECTED_ITEMS = 20;
export const NOTES_MAX_CODE_POINTS = DISPUTE_NOTES_MAX_CHARS;

export const ITEM_REF = /^E\d{1,3}$/;
/** Any ref the notes may rely on. */
export const FACT_REF = /^[EFCQ]\d{1,3}$/;

/**
 * The bounds are loose on purpose: over-long notes or an unknown ref fail the code validators (one repair
 * with a precise message, then `failed_output`), not the schema.
 */
export const DraftOutputSchema = z.object({
  notes: z.string().min(1).max(8_000),
  selected_evidence_item_ids: z.array(z.string().max(16)).min(1).max(DRAFT_MAX_SELECTED_ITEMS),
  fact_refs: z
    .array(
      z.object({
        paragraph: z.number().int().min(1).max(50),
        refs: z.array(z.string().max(16)).max(30),
      }),
    )
    .max(50),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

/** The draft's input (also the run's cache key): PayPal's dispute fields and the pack, as refs. No raw text. */
export type DraftInput = {
  readonly dispute: {
    readonly dispute_id: string;
    readonly capture_id: string | null;
    readonly reason: string | null;
    readonly reason_unmapped: boolean;
    readonly evidence_type: string;
    readonly amount: { readonly value: string; readonly currency_code: string } | null;
    readonly opened_at: string | null;
    readonly seller_response_due_date: string | null;
  };
  readonly focus: readonly FactFocus[];
  /** the pack's items: kind and date only (their content never reaches this step) */
  readonly items: readonly DraftItem[];
  readonly facts: readonly DraftFact[];
  readonly lines: readonly DraftLine[];
  readonly quotes: readonly DraftQuote[];
  /** URLs, emails and phone numbers present in the pack (not sent to the model; the notes check) */
  readonly pack_contacts: readonly string[];
};

export type DraftItem = {
  readonly ref: string;
  readonly kind: string;
  readonly added_on: string;
  readonly file: "pdf" | "image" | "text";
};

export type DraftFact = {
  readonly ref: string;
  readonly evidence_ref: string;
  readonly type: "party" | "amount" | "date" | "deliverable" | "delivery_event" | "shipment";
  readonly text: string;
};

/** A scope line with a code-checked verdict (M2-04: met, partial or missing only). */
export type DraftLine = {
  readonly ref: string;
  readonly requirement: string;
  readonly verdict: "met" | "partial" | "missing";
  /** the verified quote that states what was agreed */
  readonly agreed: string | null;
};

/** A citation that passed M2-04's verbatim check. */
export type DraftQuote = {
  readonly ref: string;
  readonly line_ref: string;
  readonly evidence_ref: string;
  readonly quote: string;
};
