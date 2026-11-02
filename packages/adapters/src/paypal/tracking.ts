// Orders v2 tracking (M3-03): the write is `PayPalOrdersClient.trackOrder` (our typed client, no PayPal
// SDK: ADR 0011 addendum). This module reads PayPal's answer: the tracker PayPal created is listed on the
// order under `purchase_units[].shipping.trackers[]` with id `{capture_id}-{tracking_number}` (M0-04
// recording), which is how an `unknown` write is reconciled (re-read the order, never resend).
import type { Order, OrderTracker } from "./schemas.ts";

/** PayPal's id for a tracker on a capture (M0-04: `6BC19320SY177903T-SPKA1793249841084`). */
export function trackerId(captureId: string, trackingNumber: string): string {
  return `${captureId}-${trackingNumber}`;
}

/** The order's tracker for this capture + tracking number, or null when PayPal does not list it. */
export function trackerFor(order: Order, captureId: string, trackingNumber: string): OrderTracker | null {
  const id = trackerId(captureId, trackingNumber);
  for (const pu of order.purchase_units) {
    const t = pu.shipping?.trackers?.find((x) => x.id === id);
    if (t !== undefined) return t;
  }
  return null;
}
