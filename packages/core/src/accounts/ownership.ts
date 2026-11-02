// Ownership of PayPal resources (ADR 0008). `paypal_resource_owner` is the source of truth; the
// resource's `custom_id` (= workspace_id on orders Cleared creates) is a cross-check, never trusted alone.
import type { WorkspaceId } from "../ids.ts";

export const PAYPAL_RESOURCE_TYPES = ["order", "capture", "dispute"] as const;
export type PayPalResourceType = (typeof PAYPAL_RESOURCE_TYPES)[number];

export interface OwnerRow {
  readonly workspaceId: WorkspaceId;
  /** ADR 0019: the workspace the row was moved from (review-hold pool); its id may still be the `custom_id` */
  readonly transferredFrom?: WorkspaceId | null;
}

export type Ownership =
  /** exactly one owner: ingest and act */
  | { readonly kind: "owned"; readonly workspaceId: WorkspaceId }
  /** the resource names a different workspace than the owner table: quarantine, never act */
  | { readonly kind: "mismatch"; readonly workspaceId: WorkspaceId; readonly customId: string }
  /** no owner row: quarantine (a payment made outside Cleared, or another app's resource) */
  | { readonly kind: "unowned"; readonly customId: string | null };

export function resolveOwner(input: {
  readonly customId: string | null;
  readonly ownerRow: OwnerRow | null;
}): Ownership {
  const { customId, ownerRow } = input;
  if (ownerRow === null) return { kind: "unowned", customId };
  const named = customId === ownerRow.workspaceId || customId === (ownerRow.transferredFrom ?? undefined);
  if (customId !== null && !named) {
    return { kind: "mismatch", workspaceId: ownerRow.workspaceId, customId };
  }
  return { kind: "owned", workspaceId: ownerRow.workspaceId };
}
