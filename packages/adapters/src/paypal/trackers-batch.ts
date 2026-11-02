// Legacy Add Tracking v1 for services (M3-04): `record_service_completed` writes one tracker with status
// COMPLETED and no tracking number through `PayPalOrdersClient.markCompleted` (our typed client on the shared
// HTTP client + token provider; no PayPal SDK, ADR 0011 addendum). This module reads PayPal's answers:
// - the batch: 200 even when a tracker fails, so a write landed only when PayPal lists the capture in
//   `tracker_identifiers` and returns no `errors` (M0-04 recording);
// - the read-back `GET /v1/shipping/trackers/{capture}-NOTRACKER`: the status PayPal stored (COMPLETED in
//   M0-04). An `unknown` write is settled by this read, never by resending.
import { HttpStatusError } from "../http/errors.ts";
import type { PayPalOrdersClient } from "./orders.ts";
import type { TrackersBatchResponse } from "./schemas.ts";

/** PayPal's id for a tracker without a tracking number (M0-04: `7AS90958XD7569923-NOTRACKER`). */
export function noTrackerId(captureId: string): string {
  return `${captureId}-NOTRACKER`;
}

export interface BatchOutcome {
  readonly accepted: boolean;
  /** PayPal's per-tracker errors (name or message), when any */
  readonly errors: readonly string[];
}

export function completedBatchOutcome(r: TrackersBatchResponse, captureId: string): BatchOutcome {
  const errors = r.errors.map((e) => e.name ?? e.message ?? "UNKNOWN_ERROR");
  const listed = r.tracker_identifiers.some((t) => t.transaction_id === captureId);
  return { accepted: listed && errors.length === 0, errors };
}

export interface ReadBack {
  /** PayPal stores a tracker for the capture with status COMPLETED */
  readonly landed: boolean;
  /** the stored status, or null when PayPal has no tracker for it (404) */
  readonly status: string | null;
}

/** Reads the capture's no-tracking-number tracker back. A 404 means it isn't there; other errors throw. */
export async function readBackCompleted(
  orders: Pick<PayPalOrdersClient, "getLegacyTracker">,
  captureId: string,
): Promise<ReadBack> {
  try {
    const t = await orders.getLegacyTracker(captureId);
    return { landed: t.status === "COMPLETED", status: t.status };
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) return { landed: false, status: null };
    throw error;
  }
}
