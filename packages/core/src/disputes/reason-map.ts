// Dispute reason → PayPal `evidence_type` and the facts that matter (M2-07). Pure.
// - The table maps the two reasons a small cross-border seller meets most; any other reason falls back to
//   `OTHER` and is flagged `reason_unmapped` so the seller sees the draft was not tailored to the reason.
// - When the re-fetched dispute lists the evidence PayPal requests from the seller (`evidences[]` entries with
//   `source: REQUESTED_FROM_SELLER`, as recorded in the M0-05 fixtures), PayPal's request wins over the table:
//   the first requested type in PayPal's order that a proof pack can supply. `PROOF_OF_REFUND` is skipped:
//   a refund is the seller's own decision (accept-claim, M2-08/M2-09), never something the agent drafts.

/** What the draft leads with. */
export const FACT_FOCUSES = ["delivery_events", "shipment", "scope_verdicts", "acceptance"] as const;
export type FactFocus = (typeof FACT_FOCUSES)[number];

interface ReasonRow {
  readonly evidenceType: string;
  readonly focus: readonly FactFocus[];
}

export const REASON_TABLE: Readonly<Record<string, ReasonRow>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: {
    evidenceType: "PROOF_OF_FULFILLMENT",
    focus: ["delivery_events", "shipment"],
  },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: {
    evidenceType: "OTHER",
    focus: ["scope_verdicts", "acceptance"],
  },
};

export const DEFAULT_EVIDENCE_TYPE = "OTHER";

/** Requested types a proof pack never supplies. */
export const UNDRAFTABLE_EVIDENCE_TYPES: readonly string[] = ["PROOF_OF_REFUND"];

/** PayPal's evidence-type grammar, as the M2-08 executable payload accepts it. */
const EVIDENCE_TYPE = /^[A-Z_]{1,64}$/;

export type EvidenceTypeSource = "paypal_request" | "reason_table" | "default";

export interface ReasonMapping {
  readonly evidenceType: string;
  readonly source: EvidenceTypeSource;
  /** the reason is not in the table: the seller is told the draft is generic */
  readonly reasonUnmapped: boolean;
  readonly focus: readonly FactFocus[];
}

interface DisputeEvidenceEntry {
  readonly evidence_type: string;
  readonly source?: string | undefined;
}

/** The evidence types PayPal requests from the seller, in PayPal's order, without duplicates. */
export function requestedEvidenceTypes(evidences: readonly DisputeEvidenceEntry[] | undefined): string[] {
  const out: string[] = [];
  for (const e of evidences ?? []) {
    if (e.source !== "REQUESTED_FROM_SELLER" || !EVIDENCE_TYPE.test(e.evidence_type)) continue;
    if (!out.includes(e.evidence_type)) out.push(e.evidence_type);
  }
  return out;
}

export function mapReason(reason: string | null, requested: readonly string[]): ReasonMapping {
  const row = reason === null ? undefined : REASON_TABLE[reason];
  const reasonUnmapped = row === undefined;
  const focus = row?.focus ?? FACT_FOCUSES;
  const fromPayPal = requested.find((t) => EVIDENCE_TYPE.test(t) && !UNDRAFTABLE_EVIDENCE_TYPES.includes(t));
  if (fromPayPal !== undefined)
    return { evidenceType: fromPayPal, source: "paypal_request", reasonUnmapped, focus };
  if (row) return { evidenceType: row.evidenceType, source: "reason_table", reasonUnmapped, focus };
  return { evidenceType: DEFAULT_EVIDENCE_TYPE, source: "default", reasonUnmapped, focus };
}

/** The filing action a draft proposes: `provide_evidence` when the dispute's links offer it, else supporting info. */
export type FilingKind = "provide_evidence" | "provide_supporting_info";

export function filingKindFor(allowedActions: readonly string[]): FilingKind | null {
  if (allowedActions.includes("provide_evidence")) return "provide_evidence";
  if (allowedActions.includes("provide_supporting_info")) return "provide_supporting_info";
  return null;
}
