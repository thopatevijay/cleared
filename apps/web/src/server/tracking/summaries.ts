// M3-03: the tracking summary of each goods hold (route advice + where the `add_tracking` action stands),
// from the workspace's own rows: the newest tracking action on the capture and the newest shipment fact in
// the payment's proof pack. Only goods holds get one: the "faster release" copy belongs to holds awaiting
// delivery confirmation, never to payment-review holds (research note on #35).
import { ACTION_STATES, trackingSummary, type TrackingSummary } from "@cleared/core";
import { z } from "zod";
import { trackingReads, type Db, type HoldRow } from "@cleared/db";

export interface GoodsHoldRef {
  readonly hold: Pick<HoldRow, "id" | "type" | "state">;
  readonly payment: { readonly id: string; readonly captureId: string };
}

export async function trackingSummaries(
  db: Db,
  ws: string,
  refs: readonly GoodsHoldRef[],
  timeZone: string,
): Promise<Map<string, TrackingSummary>> {
  const goods = refs.filter((r) => r.hold.type === "goods");
  if (goods.length === 0) return new Map();
  const reads = trackingReads(db, ws);
  const [actions, shipments] = await Promise.all([
    reads.latestTrackingActions(goods.map((r) => r.payment.captureId)),
    reads.shipmentsByPayment(goods.map((r) => r.payment.id)),
  ]);
  return new Map(
    goods.map((r) => {
      const a = actions.get(r.payment.captureId);
      const s = shipments.get(r.payment.id);
      const summary = trackingSummary({
        holdState: r.hold.state,
        action:
          a === undefined
            ? null
            : { id: a.id, state: z.enum(ACTION_STATES).parse(a.state), payload: a.payload },
        shipment: s === undefined ? null : { carrier: s.carrier, tracking_number: s.tracking_number },
        timeZone,
      });
      return [r.hold.id, summary] as const;
    }),
  );
}
