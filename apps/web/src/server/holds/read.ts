// M3-01 holds read models (hold.md): the inbox list with the held total per currency, and one hold's
// detail. Workspace-scoped, and only holds on captures this workspace owns (`holdsRepo`). The upper bound
// of an estimate is recomputed from the hold's rule row, so the estimate and its source always agree.
import {
  fromEpochMs,
  holdRule,
  HOLD_TYPES,
  HoldDetailSchema,
  HoldsResponseSchema,
  type HoldDetail,
  type HoldItem,
  type HoldsResponse,
  type HoldType,
  type PaymentHold,
  type WorkspaceId,
} from "@cleared/core";
import { holdsRepo, platform, type HoldRow, type HoldView } from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const holdType = (t: string): HoldType =>
  (HOLD_TYPES as readonly string[]).includes(t) ? (t as HoldType) : "other";

/** The rule's later bound (payment review: 3 business days), from the hold's opening. */
function upperBound(h: Pick<HoldRow, "estimateSource" | "openedAt">): string | null {
  const rule = h.estimateSource === null ? null : holdRule(h.estimateSource);
  return rule?.estimate(fromEpochMs(h.openedAt.getTime()))?.upperBound ?? null;
}

/** The dashboard row's hold (dashboard.md elements 7–10). */
export function paymentHold(h: HoldRow): PaymentHold {
  return {
    id: h.id,
    type: holdType(h.type),
    reason: h.reason,
    ruleId: h.estimateSource ?? "reason_OTHER",
    estimatedReleaseAt: iso(h.estimatedReleaseAt),
    estimateUpperBoundAt: upperBound(h),
  };
}

export function holdItem(v: HoldView): HoldItem {
  const { hold: h, payment: p, dispute: d } = v;
  return {
    ...paymentHold(h),
    paymentId: p.id,
    captureId: p.captureId,
    amount: { value: p.amount, currency: p.currency },
    state: h.state,
    type: holdType(h.type),
    openedAt: h.openedAt.toISOString(),
    releasedAt: iso(h.releasedAt),
    dispute:
      d === null
        ? null
        : { id: d.id, disputeId: d.disputeId, status: d.status, dueDate: iso(d.sellerResponseDueDate) },
  };
}

async function timezone(deps: Deps, ws: string): Promise<string> {
  return (await platform(deps.db).workspaces.get(ws))?.timezone ?? "UTC";
}

export async function listHolds(deps: Deps, ws: WorkspaceId): Promise<HoldsResponse> {
  const repo = holdsRepo(deps.db, ws);
  const [views, held] = await Promise.all([repo.listActive(), repo.heldTotals()]);
  return HoldsResponseSchema.parse({
    items: views.map(holdItem),
    summary: { held, count: views.length },
    workspace: { timezone: await timezone(deps, ws) },
  });
}

/** null when the id is not a uuid, or the hold is absent, foreign, or on a capture this workspace doesn't own. */
export async function holdDetail(deps: Deps, ws: WorkspaceId, rawId: string): Promise<HoldDetail | null> {
  if (!z.uuid().safeParse(rawId).success) return null;
  const v = await holdsRepo(deps.db, ws).view(rawId);
  if (v === null) return null;
  return HoldDetailSchema.parse({
    hold: holdItem(v),
    payment: { id: v.payment.id, status: v.payment.status, statusReason: v.payment.statusReason },
    workspace: { timezone: await timezone(deps, ws) },
  });
}
