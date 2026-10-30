// Branded identifiers. Our own ids are UUIDs; PayPal ids are opaque tokens kept verbatim.
import { z } from "zod";
import { domainError, type DomainError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/** PayPal ids: `2KC08730ML031160C` (order, capture), `PP-R-UVC-10195076` (dispute). Kept verbatim. */
const PAYPAL_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export const WorkspaceIdSchema = z.uuid().brand<"WorkspaceId">();
export const ActionIdSchema = z.uuid().brand<"ActionId">();
export const ProofPackIdSchema = z.uuid().brand<"ProofPackId">();
export const EvidenceItemIdSchema = z.uuid().brand<"EvidenceItemId">();
export const HoldIdSchema = z.uuid().brand<"HoldId">();
export const CaptureIdSchema = z.string().regex(PAYPAL_ID).brand<"CaptureId">();
export const OrderIdSchema = z.string().regex(PAYPAL_ID).brand<"OrderId">();
export const DisputeIdSchema = z.string().regex(PAYPAL_ID).brand<"DisputeId">();

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ProofPackId = z.infer<typeof ProofPackIdSchema>;
export type EvidenceItemId = z.infer<typeof EvidenceItemIdSchema>;
export type HoldId = z.infer<typeof HoldIdSchema>;
export type CaptureId = z.infer<typeof CaptureIdSchema>;
export type OrderId = z.infer<typeof OrderIdSchema>;
export type DisputeId = z.infer<typeof DisputeIdSchema>;

/** sha256 as 64 lowercase hex characters. Hashing itself happens in adapters. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"Sha256">();
export type Sha256 = z.infer<typeof Sha256Schema>;

/** Parses a raw value with an id schema, returning a domain error instead of throwing. */
export function parseId<S extends z.ZodType>(schema: S, raw: unknown): Result<z.infer<S>, DomainError> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err(domainError("invalid_id", "not a valid identifier", { raw }));
}
