// Typed PayPal Customer Disputes v1 client (the SDK has no Disputes; ADR 0011 addendum). Every call
// runs through the shared HTTP client and the one token provider.
//
// Rules this module enforces (CLAUDE.md, domain rules):
// - allowed actions come ONLY from the dispute's HATEOAS `links[].rel`, never from a status map;
// - every write re-fetches the dispute and refuses, before any write call, if its link is absent;
// - every write carries a `PayPal-Request-Id`; writes are not retried automatically (see
//   DISPUTE_WRITES_IDEMPOTENT): a timeout is an UNKNOWN outcome, reconciled by re-reading;
// - evidence files and notes are checked client-side before anything is sent;
// - chargeback creation, require-evidence and adjudicate exist only in the sandbox and refuse anywhere else.
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { HttpClient, HttpMethod } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";
import {
  ChargebackResponseSchema,
  DisputeListSchema,
  DisputeSchema,
  DisputeWriteResponseSchema,
  type Dispute,
  type DisputeList,
  type DisputeWriteResponse,
} from "./dispute-schemas.ts";
import { PAYPAL_SANDBOX_BASE_URL, PayPalApiError } from "./orders.ts";
import type { Money } from "./schemas.ts";
import type { TokenProvider } from "./token.ts";

/** Link rels PayPal uses for dispute actions; `allowedActions` returns the subset present. */
export const DISPUTE_ACTIONS = [
  "provide_supporting_info",
  "provide_evidence",
  "accept_claim",
  "make_offer",
  "send_message",
  "escalate",
  "acknowledge_return_item",
  "appeal",
  "require_evidence",
  "adjudicate",
] as const;
export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

/**
 * Whether dispute writes may be retried on timeout / 5xx with the same PayPal-Request-Id.
 * Measured in M0-05 (docs/evidence/m0-05-paypal-spike-b.md): see the unknown-outcome finding.
 */
export const DISPUTE_WRITES_IDEMPOTENT = false;

// PayPal's published limits (developer.paypal.com/disputes/supported-file-sizes-types). Decimal MB:
// the stricter reading of "less than 10 MB per file, up to 50 MB per call".
export const EVIDENCE_LIMITS = {
  maxFileBytes: 10_000_000,
  maxTotalBytes: 50_000_000,
  maxNotesChars: 2000,
  extensions: ["jpg", "jpeg", "gif", "png", "pdf"],
} as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  png: "image/png",
  pdf: "application/pdf",
};

// --- errors -------------------------------------------------------------------------------------

/** The dispute's current links do not offer this action. Raised before the write is sent. */
export class DisputeActionNotAllowedError extends Error {
  readonly action: DisputeAction;
  readonly status: string;
  readonly available: readonly DisputeAction[];

  constructor(action: DisputeAction, dispute: Dispute) {
    const available = allowedActions(dispute);
    super(
      `${action} not offered by dispute ${dispute.dispute_id} (${dispute.status}); links: ${available.join(", ") || "none"}`,
    );
    this.name = "DisputeActionNotAllowedError";
    this.action = action;
    this.status = dispute.status;
    this.available = available;
  }
}

/** An evidence file or note failed PayPal's published limits; nothing was sent. */
export class EvidenceRejectedError extends Error {
  readonly code: "FILE_TYPE" | "FILE_TOO_LARGE" | "TOTAL_TOO_LARGE" | "NOTES_TOO_LONG" | "EMPTY";

  constructor(code: EvidenceRejectedError["code"], message: string) {
    super(message);
    this.name = "EvidenceRejectedError";
    this.code = code;
  }
}

/** A sandbox-only endpoint was called outside the sandbox (PAYPAL_ENV or base URL). */
export class SandboxOnlyError extends Error {
  constructor(operation: string, env: string | undefined) {
    super(`${operation} is sandbox only; PAYPAL_ENV is ${JSON.stringify(env ?? null)}`);
    this.name = "SandboxOnlyError";
  }
}

// --- pure helpers -------------------------------------------------------------------------------

/** Actions the dispute offers right now: derived ONLY from `links[].rel`. */
export function allowedActions(dispute: Pick<Dispute, "links">): DisputeAction[] {
  const rels = new Set(dispute.links.map((l) => l.rel));
  return DISPUTE_ACTIONS.filter((a) => rels.has(a));
}

export interface EvidenceFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Client-side checks against PayPal's file limits. Throws EvidenceRejectedError. */
export function checkEvidenceFiles(files: readonly EvidenceFile[]): void {
  let total = 0;
  for (const f of files) {
    const ext = extension(f.name);
    if (ext === undefined || !(EVIDENCE_LIMITS.extensions as readonly string[]).includes(ext)) {
      throw new EvidenceRejectedError("FILE_TYPE", `${f.name}: only jpg, gif, png or pdf files are accepted`);
    }
    if (f.bytes.byteLength === 0) throw new EvidenceRejectedError("EMPTY", `${f.name} is empty`);
    if (f.bytes.byteLength >= EVIDENCE_LIMITS.maxFileBytes) {
      throw new EvidenceRejectedError("FILE_TOO_LARGE", `${f.name} must be under 10 MB`);
    }
    total += f.bytes.byteLength;
  }
  if (total > EVIDENCE_LIMITS.maxTotalBytes) {
    throw new EvidenceRejectedError("TOTAL_TOO_LARGE", "files must total 50 MB or less per call");
  }
}

/** Notes are at most 2000 characters (UTF-16 length: never under-counts). */
export function checkNotes(notes: string | undefined): void {
  if (notes !== undefined && notes.length > EVIDENCE_LIMITS.maxNotesChars) {
    throw new EvidenceRejectedError(
      "NOTES_TOO_LONG",
      `notes are ${String(notes.length)} characters; the limit is 2000`,
    );
  }
}

function extension(name: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m?.[1]?.toLowerCase();
}

export interface Multipart {
  readonly body: Uint8Array;
  readonly contentType: string;
  /** The body as text with each file's bytes replaced by name, size and sha256 (for recording). */
  readonly preview: string;
}

/** multipart/form-data: an `input` JSON part, then `file1`…`fileN`. */
export function buildMultipart(
  input: unknown,
  files: readonly EvidenceFile[],
  boundary = randomUUID().replaceAll("-", ""),
): Multipart {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const preview: string[] = [];
  const push = (text: string): void => {
    chunks.push(enc.encode(text));
    preview.push(text);
  };
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(input)}\r\n`,
  );
  files.forEach((f, i) => {
    const type = CONTENT_TYPES[extension(f.name) ?? ""] ?? "application/octet-stream";
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file${String(i + 1)}"; filename="${f.name.replaceAll('"', "")}"\r\nContent-Type: ${type}\r\n\r\n`,
    );
    chunks.push(f.bytes);
    preview.push(
      `[${type} ${String(f.bytes.byteLength)} bytes sha256:${createHash("sha256").update(f.bytes).digest("hex")}]`,
    );
    push("\r\n");
  });
  push(`--${boundary}--\r\n`);
  return {
    body: concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    preview: preview.join(""),
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// --- outcome and reconcile ----------------------------------------------------------------------

export type OutcomeSummary =
  | { readonly kind: "open" }
  | {
      readonly kind: "seller_keeps_paypal_covered";
      readonly text: "seller keeps the money (PayPal covered the case)";
    }
  | { readonly kind: "seller_favour"; readonly text: "resolved in the seller's favour" }
  | { readonly kind: "buyer_refunded"; readonly text: "resolved for the buyer (refunded)" }
  | { readonly kind: "canceled_by_buyer"; readonly text: "the buyer cancelled the case" }
  | { readonly kind: "unmapped"; readonly code: string; readonly reason: string | undefined };

/** How to describe a dispute's outcome. Never claims more than PayPal's outcome code says. */
export function describeOutcome(d: Pick<Dispute, "status" | "dispute_outcome">): OutcomeSummary {
  const o = d.dispute_outcome;
  if (d.status !== "RESOLVED" || o === undefined) return { kind: "open" };
  if (o.outcome_code === "RESOLVED_WITH_PAYOUT" && o.outcome_reason === "REPRESENTED_BY_PAYPAL") {
    return { kind: "seller_keeps_paypal_covered", text: "seller keeps the money (PayPal covered the case)" };
  }
  if (o.outcome_code === "RESOLVED_SELLER_FAVOUR")
    return { kind: "seller_favour", text: "resolved in the seller's favour" };
  if (o.outcome_code === "RESOLVED_BUYER_FAVOUR" || o.outcome_code === "ACCEPTED") {
    return { kind: "buyer_refunded", text: "resolved for the buyer (refunded)" };
  }
  if (o.outcome_code === "CANCELED_BY_BUYER")
    return { kind: "canceled_by_buyer", text: "the buyer cancelled the case" };
  return { kind: "unmapped", code: o.outcome_code, reason: o.outcome_reason };
}

export type ReconcileVerdict = "landed" | "not_landed";

/**
 * After a write timed out (outcome unknown), decide from a fresh re-read whether it landed.
 * Seller submissions (evidence + supporting info) count for the submit actions; for the others the
 * action's link disappearing or the status moving is the proof. `update_time` alone is not: PayPal
 * moves it for its own reasons.
 */
export function reconcileAfterTimeout(
  action: DisputeAction,
  before: Dispute,
  after: Dispute,
): ReconcileVerdict {
  if (action === "provide_supporting_info" || action === "provide_evidence") {
    return sellerSubmissions(after) > sellerSubmissions(before) ? "landed" : "not_landed";
  }
  const linkGone = allowedActions(before).includes(action) && !allowedActions(after).includes(action);
  return linkGone || after.status !== before.status ? "landed" : "not_landed";
}

/** Supporting-info entries plus evidence the seller submitted. */
export function sellerSubmissions(d: Dispute): number {
  const evidence = (d.evidences ?? []).filter((e) => e.source === "SUBMITTED_BY_SELLER").length;
  return evidence + (d.supporting_info ?? []).length;
}

// --- client -------------------------------------------------------------------------------------

export interface WriteOptions {
  /** `PayPal-Request-Id`; the same id on a retry lets PayPal recognise the repeat. */
  readonly requestId: string;
  /** Per-call timeout for the write itself (the re-check GET uses the client default). */
  readonly timeoutMs?: number;
}

export interface ChargebackInput {
  readonly captureId: string;
  readonly amount: Money;
  /** The seller's PayPal merchant id (the order's `payee.merchant_id`). */
  readonly merchantId: string;
  /** Card-network reason code (sandbox): `C2` → not as described. */
  readonly reasonCode?: string;
  readonly requestId: string;
}

export interface PayPalDisputesClient {
  listDisputes(q?: { updateTimeAfter?: string; pageSize?: number }): Promise<DisputeList>;
  getDispute(id: string): Promise<Dispute>;
  provideSupportingInfo(
    id: string,
    input: { notes: string; files?: readonly EvidenceFile[] },
    o: WriteOptions,
  ): Promise<DisputeWriteResponse>;
  provideEvidence(
    id: string,
    input: { evidenceType: string; notes?: string; files: readonly EvidenceFile[] },
    o: WriteOptions,
  ): Promise<DisputeWriteResponse>;
  acceptClaim(
    id: string,
    input: { note: string; acceptClaimType?: string },
    o: WriteOptions,
  ): Promise<DisputeWriteResponse>;
  /** Sandbox only. */
  processChargeback(input: ChargebackInput): Promise<{ dispute_id: string }>;
  /** Sandbox only: moves a dispute to wait for the given party's evidence. */
  requireEvidence(
    id: string,
    party: "SELLER_EVIDENCE" | "BUYER_EVIDENCE",
    o: WriteOptions,
  ): Promise<DisputeWriteResponse>;
  /** Sandbox only: PayPal's decision, simulated. Label it as such in any UI. */
  adjudicate(
    id: string,
    outcome: "SELLER_FAVOR" | "BUYER_FAVOR",
    o: WriteOptions,
  ): Promise<DisputeWriteResponse>;
}

export interface PayPalDisputesClientOptions {
  readonly http: HttpClient;
  readonly tokens: TokenProvider;
  readonly baseUrl?: string;
  /** Defaults to `process.env.PAYPAL_ENV`, read at call time. Sandbox-only calls need "sandbox". */
  readonly env?: () => string | undefined;
}

export interface SendOptions<S extends z.ZodType> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly schema: S;
  readonly json?: unknown;
  readonly multipart?: Multipart;
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

export interface DisputesTransport {
  send<S extends z.ZodType>(o: SendOptions<S>): Promise<z.infer<S>>;
}

/** The raw, UNGUARDED call layer. Product code uses `createPayPalDisputesClient`; spikes use this to record PayPal's own refusals. */
export function createDisputesTransport(
  options: Pick<PayPalDisputesClientOptions, "http" | "tokens" | "baseUrl">,
): DisputesTransport {
  const base = options.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;
  async function send<S extends z.ZodType>(o: SendOptions<S>): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (o.json !== undefined) headers["content-type"] = "application/json";
    if (o.multipart !== undefined) headers["content-type"] = o.multipart.contentType;
    if (o.requestId !== undefined) headers["paypal-request-id"] = o.requestId;
    const body = o.multipart?.body ?? (o.json === undefined ? undefined : JSON.stringify(o.json));
    try {
      const res = await options.tokens.withToken((bearer) =>
        options.http.request({
          method: o.method,
          url: `${base}${o.path}`,
          headers: { ...headers, authorization: `Bearer ${bearer}` },
          ...(body === undefined ? {} : { body }),
          ...(o.multipart === undefined ? {} : { bodyPreview: o.multipart.preview }),
          ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
          idempotent: o.method === "GET" || DISPUTE_WRITES_IDEMPOTENT,
        }),
      );
      return o.schema.parse(res.bodyText.trim() === "" ? {} : JSON.parse(res.bodyText));
    } catch (err) {
      if (err instanceof HttpStatusError) throw new PayPalApiError(err);
      throw err;
    }
  }
  return { send };
}

export function createPayPalDisputesClient(options: PayPalDisputesClientOptions): PayPalDisputesClient {
  const t = createDisputesTransport(options);
  const env = options.env ?? (() => process.env.PAYPAL_ENV);
  const sandboxBase = (options.baseUrl ?? PAYPAL_SANDBOX_BASE_URL) === PAYPAL_SANDBOX_BASE_URL;
  const sandboxOnly = (op: string): void => {
    const e = env();
    if (e !== "sandbox" || !sandboxBase) throw new SandboxOnlyError(op, e);
  };
  const getDispute = (id: string): Promise<Dispute> =>
    t.send({ method: "GET", path: `/v1/customer/disputes/${seg(id)}`, schema: DisputeSchema });

  /** Fresh re-read; refuses before the write if the action's link is absent. */
  async function guarded(
    id: string,
    action: DisputeAction,
    o: WriteOptions,
    write: (path: string) => SendOptions<typeof DisputeWriteResponseSchema>,
  ): Promise<DisputeWriteResponse> {
    const d = await getDispute(id);
    if (!allowedActions(d).includes(action)) throw new DisputeActionNotAllowedError(action, d);
    const path = `/v1/customer/disputes/${seg(id)}/${action.replaceAll("_", "-")}`;
    return t.send({
      ...write(path),
      requestId: o.requestId,
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    });
  }
  const post = (path: string, json: unknown) => ({
    method: "POST" as const,
    path,
    schema: DisputeWriteResponseSchema,
    json,
  });
  const postMultipart = (path: string, multipart: Multipart) => ({
    method: "POST" as const,
    path,
    schema: DisputeWriteResponseSchema,
    multipart,
  });

  return {
    getDispute,
    listDisputes: (q = {}) => {
      const params = new URLSearchParams();
      if (q.updateTimeAfter !== undefined) params.set("update_time_after", q.updateTimeAfter);
      params.set("page_size", String(q.pageSize ?? 50));
      return t.send({
        method: "GET",
        path: `/v1/customer/disputes?${params.toString()}`,
        schema: DisputeListSchema,
      });
    },
    provideSupportingInfo: async (id, input, o) => {
      checkNotes(input.notes);
      checkEvidenceFiles(input.files ?? []);
      return guarded(id, "provide_supporting_info", o, (p) =>
        postMultipart(p, buildMultipart({ notes: input.notes }, input.files ?? [])),
      );
    },
    provideEvidence: async (id, input, o) => {
      checkNotes(input.notes);
      if (input.files.length === 0 && input.notes === undefined)
        throw new EvidenceRejectedError("EMPTY", "evidence needs a file or notes");
      checkEvidenceFiles(input.files);
      const evidence = {
        evidence_type: input.evidenceType,
        documents: input.files.map((f) => ({ name: f.name })),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      };
      return guarded(id, "provide_evidence", o, (p) =>
        postMultipart(p, buildMultipart({ evidences: [evidence] }, input.files)),
      );
    },
    acceptClaim: async (id, input, o) => {
      checkNotes(input.note);
      return guarded(id, "accept_claim", o, (p) =>
        post(p, { note: input.note, accept_claim_type: input.acceptClaimType ?? "REFUND" }),
      );
    },
    processChargeback: async (input) => {
      sandboxOnly("processChargeback");
      return t.send({
        method: "POST",
        path: "/v2/customer-support/process-chargeback",
        schema: ChargebackResponseSchema,
        json: chargebackBody(input),
        requestId: input.requestId,
      });
    },
    requireEvidence: async (id, party, o) => {
      sandboxOnly("requireEvidence");
      return guarded(id, "require_evidence", o, (p) => post(p, { action: party }));
    },
    adjudicate: async (id, outcome, o) => {
      sandboxOnly("adjudicate");
      return guarded(id, "adjudicate", o, (p) => post(p, { adjudication_outcome: outcome }));
    },
  };
}

/** The sandbox chargeback simulation body (prior spike, notes/feasibility.md: 201 + dispute id). */
function chargebackBody(input: ChargebackInput): unknown {
  const now = new Date();
  const iso = (d: Date): string => d.toISOString();
  return {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: input.merchantId,
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: input.captureId, amount: input.amount },
    instrument: {
      instrument_type: "CARD",
      card_brand: "VISA",
      credit_card_transaction_id: digits(16),
      external: false,
    },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: iso(new Date(now.getTime() + 10 * 86_400_000)),
      status: "2",
      amount: input.amount,
      receive_date: iso(now),
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: iso(now),
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: {
        reference_number: digits(23),
        reason_code: input.reasonCode ?? "C2",
        notes: "Cleared sandbox chargeback",
      },
    },
  };
}

function digits(n: number): string {
  let out = "";
  while (out.length < n) out += BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
  return out.slice(0, n);
}

/** PayPal dispute ids look like PP-R-GXJ-10194893 / PP-D-1234. */
function seg(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid PayPal id segment: ${JSON.stringify(id)}`);
  return id;
}
