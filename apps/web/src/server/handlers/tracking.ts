// M3-03 tracking proposal (hold.md action slot, ApprovalCard `add_tracking`):
//   POST /api/holds/:id/tracking   {carrier, carrier_name_other?, tracking_number}
// The seller states the carrier and tracking number (prefilled from the shipment evidence); the server binds
// them to the hold's order and capture as a seller-created `add_tracking` proposal (notify_payer false). It
// is only a proposal: the seller then approves its exact payload sha256 through POST /api/actions/:id/approve,
// and the worker files it. A newer proposal supersedes an older one still waiting (one fingerprint shown).
import {
  AddTrackingPayloadSchema,
  classifyCarrier,
  declaredKindOf,
  guidedAction,
  holdTypeOf,
  OTHER_CARRIER,
} from "@cleared/core";
import {
  appendActionAudit,
  holdsRepo,
  insertSellerProposal,
  setProposedActionState,
  trackingReads,
  withTransaction,
  type Db,
  type ProposedActionRow,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { guidedUnderLock } from "../holds/declaration.ts";
import { withIdempotency } from "../idempotency.ts";
import { json } from "../respond.ts";
import { withRenewal } from "../session.ts";
import { actorOf, mutation, refusal, view } from "./actions.ts";

const BodySchema = z.strictObject({
  carrier: z.string().trim().min(1).max(64),
  carrier_name_other: z.string().trim().min(1).max(64).optional(),
  tracking_number: z.string().trim().min(1).max(64),
});

const IN_FLIGHT = new Set(["approved", "executing", "unknown"]);

type Refusal = readonly [status: number, code: string, message: string];

const R = {
  notFound: [404, "NOT_FOUND", "No such hold in this workspace."],
  notGoods: [
    409,
    "NOT_GOODS_HOLD",
    "Tracking applies to goods payments only. Mark this payment as goods first.",
  ],
  done: [409, "TRACKING_NOT_NEEDED", "This hold is released or its tracking is already filed."],
  noOrder: [409, "ORDER_UNKNOWN", "The PayPal order for this payment is not known yet. Try again shortly."],
  carrier: [422, "UNKNOWN_CARRIER", "PayPal does not list this carrier. Choose one from the list or Other."],
  invalid: [422, "INVALID_TRACKING", "Check the tracking number: letters, digits and dashes, up to 64."],
  busy: [409, "TRACKING_IN_PROGRESS", "Tracking for this payment is already being filed."],
} as const satisfies Record<string, Refusal>;

/** Older `proposed` tracking on the same capture → `rejected`, with its audit row (superseded). */
export async function supersede(db: Db, prev: ProposedActionRow, by: string, actor: string, tx: Tx) {
  if (
    !(await setProposedActionState(db, prev.workspaceId, prev.id, { from: "proposed", to: "rejected" }, tx))
  )
    return;
  await appendActionAudit(
    db,
    {
      workspaceId: prev.workspaceId,
      actionId: prev.id,
      actor: "seller",
      action: "action.superseded",
      detail: { by, supersededBy: actor },
    },
    tx,
  );
}

export async function postTrackingProposal(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, BodySchema);
  if (m instanceof Response) return m;
  const no = (r: Refusal) => refusal(req, r[0], r[1], r[2]);
  const ws = m.session.workspaceId;
  const v = z.uuid().safeParse(rawId).success ? await holdsRepo(deps.db, ws).view(rawId) : null;
  if (v === null) return no(R.notFound);
  // a hold PayPal typed goods, or one the seller declared goods (BL-01 6570499264)
  if (guidedAction(holdTypeOf(v.hold.type), declaredKindOf(v.hold.sellerDeclaredKind)) !== "tracking")
    return no(R.notGoods);
  if (!["open", "explained", "action_proposed", "approved"].includes(v.hold.state)) return no(R.done);
  if (v.payment.orderId === null) return no(R.noOrder);
  const other = m.body.carrier === OTHER_CARRIER ? m.body.carrier_name_other : undefined;
  if (classifyCarrier(m.body.carrier, other) === null) return no(R.carrier);
  const payload = AddTrackingPayloadSchema.safeParse({
    order_id: v.payment.orderId,
    capture_id: v.payment.captureId,
    carrier: m.body.carrier,
    ...(other === undefined ? {} : { carrier_name_other: other }),
    tracking_number: m.body.tracking_number.replace(/\s+/g, ""),
    notify_payer: false,
  });
  if (!payload.success) return no(R.invalid);
  const scope = { scopeId: m.session.sessionId, route: `POST /api/holds/${v.hold.id}/tracking`, key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const prev = (await trackingReads(deps.db, ws).latestTrackingActions([v.payment.captureId])).get(
      v.payment.captureId,
    );
    if (prev !== undefined && IN_FLIGHT.has(prev.state)) return no(R.busy);
    const actor = actorOf(m.session);
    const row = await withTransaction(deps.db, async (tx) => {
      const ids = { paymentId: v.payment.id, holdId: v.hold.id };
      if ((await guidedUnderLock(deps.db, ws, ids, tx)) !== "tracking") return null;
      const created = await insertSellerProposal(
        deps.db,
        {
          workspaceId: ws,
          proposedBy: actor,
          kind: "add_tracking",
          payload: payload.data,
          detail: { holdId: v.hold.id },
        },
        tx,
      );
      if (prev?.state === "proposed") await supersede(deps.db, prev, created.id, actor, tx);
      return created;
    });
    if (row === null) return no(R.notGoods);
    return withRenewal(json({ action: await view(deps, row) }, 201), m.session);
  });
}
