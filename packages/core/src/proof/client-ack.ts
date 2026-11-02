// Client acknowledgement link (M3-06): the buyer confirms "I agree to this scope" through a one-time link.
// Pure rules only: token shape and hash, expiry, the link's status, the accept form and the canonical text
// of the `client_ack` evidence item. Token generation (randomness) and storage live in apps/web.
import { z } from "zod";
import { canonicalJson } from "../actions/canonical-json.ts";
import { sha256Hex } from "../agent/canonical-hash.ts";
import type { Sha256 } from "../ids.ts";
import { evidenceHashInput } from "./evidence.ts";

/** 32 random bytes, base64url without padding: 43 characters. */
export const ACK_TOKEN_BYTES = 32;
export const AckTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const ACK_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACK_NAME_MAX_CHARS = 120;
export const ACK_USER_AGENT_MAX_CHARS = 512;

/** Rate limits on the public accept route (per rolling window). */
export const ACK_RATE_WINDOW_MS = 15 * 60 * 1000;
export const ACK_RATE_PER_IP = 20;
export const ACK_RATE_PER_TOKEN = 10;

/** Only this hash is stored (`client_acks.token_hash`); the raw token exists only in the link. */
export function ackTokenHash(token: string): Sha256 {
  return sha256Hex(token);
}

/** 30 days from creation, or the workspace's own expiry (demo workspaces) when that comes first. */
export function ackLinkExpiry(createdAt: Date, workspaceExpiresAt: Date | null): Date {
  const ttl = new Date(createdAt.getTime() + ACK_LINK_TTL_MS);
  return workspaceExpiresAt !== null && workspaceExpiresAt < ttl ? workspaceExpiresAt : ttl;
}

export const ACK_LINK_STATUSES = ["pending", "accepted", "expired", "revoked", "scope_changed"] as const;
export type AckLinkStatus = (typeof ACK_LINK_STATUSES)[number];

export interface AckLinkFacts {
  readonly scopeSha256: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * A link's status against the pack's current scope item (`null`: the pack has no scope item). Acceptance
 * and revocation are final; a link bound to an older scope text is void even before it expires.
 */
export function ackLinkStatus(
  link: AckLinkFacts,
  currentScopeSha256: string | null,
  now: Date,
): AckLinkStatus {
  if (link.acceptedAt !== null) return "accepted";
  if (link.revokedAt !== null) return "revoked";
  if (currentScopeSha256 !== link.scopeSha256) return "scope_changed";
  if (now >= link.expiresAt) return "expired";
  return "pending";
}

/** Whitespace-trimmed, NFC, no control characters, 1..120 characters. */
export const AckNameSchema = z
  .string()
  .transform((s) => s.normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(ACK_NAME_MAX_CHARS)
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  );

/** The public accept form: the typed name and the ticked box. */
export const AckSubmitSchema = z.strictObject({ name: AckNameSchema, agree: z.literal(true) });
export type AckSubmit = z.infer<typeof AckSubmitSchema>;

export interface AckRecord {
  readonly scopeSha256: string;
  readonly typedName: string;
  readonly acceptedAt: Date;
  readonly ip: string;
  readonly userAgent: string;
}

/** The `client_ack` evidence text: canonical JSON (sorted keys, no whitespace) and its evidence sha256. */
export function clientAckEvidence(r: AckRecord): { readonly text: string; readonly sha256: Sha256 } {
  const text = canonicalJson({
    scope_sha256: r.scopeSha256,
    typed_name: r.typedName,
    accepted_at: r.acceptedAt.toISOString(),
    ip: r.ip,
    user_agent: r.userAgent.slice(0, ACK_USER_AGENT_MAX_CHARS),
  });
  return { text, sha256: sha256Hex(evidenceHashInput({ kind: "text", text })) };
}

/** The seller's view of the pack's newest link (GET /api/packs/:packId/ack-links). */
export const AckLinkViewSchema = z.object({
  /** the pack's current scope item, or null: no link can be created yet */
  scopeItemId: z.uuid().nullable(),
  link: z
    .object({
      id: z.uuid(),
      status: z.enum(ACK_LINK_STATUSES),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      /** the workspace's expiry capped the 30 days */
      expiryCapped: z.boolean(),
      acceptedAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      /** the accepted link was bound to an older scope item */
      earlierScope: z.boolean(),
      evidenceItemId: z.uuid().nullable(),
    })
    .nullable(),
});
export type AckLinkView = z.infer<typeof AckLinkViewSchema>;

/** POST /api/packs/:packId/ack-links → 201: the raw URL, returned this once and never stored. */
export const AckLinkCreatedSchema = z.object({ url: z.url(), view: AckLinkViewSchema });
export type AckLinkCreated = z.infer<typeof AckLinkCreatedSchema>;
