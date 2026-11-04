// M3-01 holds read models (hold.md): the inbox list with the held total per currency, and one hold's
// detail. Workspace-scoped, and only holds on captures this workspace owns (`holdsRepo`). The upper bound
// of an estimate is recomputed from the hold's rule row, so the estimate and its source always agree.
import {
  fromEpochMs,
  holdRule,
  holdTypeOf,
  HoldDetailSchema,
  HoldsResponseSchema,
  StoredExplanationSchema,
  type HoldDetail,
  type HoldExplanation,
  type HoldItem,
  type HoldsResponse,
  type CompletedSummary,
  type PaymentHold,
  type TrackingSummary,
  type WorkspaceId,
} from "@cleared/core";
import { holdsRepo, platform, type ExplanationRow, type HoldRow, type HoldView } from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { trackingSummaries } from "../tracking/summaries.ts";
import { completedSummaries } from "../completed/summaries.ts";
import { holdGuidance, type HoldGuidance } from "./declaration.ts";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The rule's later bound (payment review: 3 business days), from the hold's opening. */
function upperBound(h: Pick<HoldRow, "estimateSource" | "openedAt">): string | null {
  const rule = h.estimateSource === null ? null : holdRule(h.estimateSource);
  return rule?.estimate(fromEpochMs(h.openedAt.getTime()))?.upperBound ?? null;
}

/** The dashboard row's hold (dashboard.md elements 7–12; M3-03 adds `tracking`; BL-01 6570499264 the declaration). */
export function paymentHold(
  h: HoldRow,
  tracking: TrackingSummary | null = null,
  guidance: HoldGuidance | null = null,
): PaymentHold {
  return {
    tracking,
    ...(guidance ?? {}),
    id: h.id,
    type: holdTypeOf(h.type),
    reason: h.reason,
    ruleId: h.estimateSource ?? "reason_OTHER",
    estimatedReleaseAt: iso(h.estimatedReleaseAt),
    estimateUpperBoundAt: upperBound(h),
  };
}

export function holdItem(
  v: HoldView,
  tracking: TrackingSummary | null = null,
  completed: CompletedSummary | null = null,
  guidance: HoldGuidance | null = null,
): HoldItem {
  const { hold: h, payment: p, dispute: d } = v;
  return {
    ...paymentHold(h, tracking, guidance),
    completed,
    paymentId: p.id,
    captureId: p.captureId,
    amount: { value: p.amount, currency: p.currency },
    state: h.state,
    type: holdTypeOf(h.type),
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

/**
 * M3-10: a demo workspace either got a judge-pool review hold when it was created ("assigned") or shows the
 * badged explainer ("none"); null for a seller workspace (the pool is a demo affordance).
 */
async function reviewPool(deps: Deps, ws: string): Promise<"assigned" | "none" | null> {
  const p = platform(deps.db);
  const [w, row] = await Promise.all([p.workspaces.get(ws), p.reviewHoldPool.assignedTo(ws)]);
  if (w?.kind !== "demo") return null;
  return row === null ? "none" : "assigned";
}

export async function listHolds(deps: Deps, ws: WorkspaceId): Promise<HoldsResponse> {
  const repo = holdsRepo(deps.db, ws);
  const [views, held, tz, pool] = await Promise.all([
    repo.listActive(),
    repo.heldTotals(),
    timezone(deps, ws),
    reviewPool(deps, ws),
  ]);
  const [tracking, completed, guidance] = await Promise.all([
    trackingSummaries(deps.db, ws, views, tz),
    completedSummaries(deps.db, ws, views),
    holdGuidance(deps.db, ws, views),
  ]);
  return HoldsResponseSchema.parse({
    items: views.map((v) =>
      holdItem(
        v,
        tracking.get(v.hold.id) ?? null,
        completed.get(v.hold.id) ?? null,
        guidance.get(v.hold.id) ?? null,
      ),
    ),
    summary: { held, count: views.length },
    workspace: { timezone: tz, reviewPool: pool },
  });
}

/** M3-02: a stored explanation (JSON in `explanations.text`); an unreadable row is left out, never shown raw. */
export function holdExplanation(row: ExplanationRow): HoldExplanation | null {
  let doc: unknown;
  try {
    doc = JSON.parse(row.text);
  } catch {
    return null;
  }
  const parsed = StoredExplanationSchema.safeParse(doc);
  return parsed.success ? { ...parsed.data, id: row.id, createdAt: row.createdAt.toISOString() } : null;
}

/** null when the id is not a uuid, or the hold is absent, foreign, or on a capture this workspace doesn't own. */
export async function holdDetail(deps: Deps, ws: WorkspaceId, rawId: string): Promise<HoldDetail | null> {
  if (!z.uuid().safeParse(rawId).success) return null;
  const repo = holdsRepo(deps.db, ws);
  // M4-08: the hold, the zone and the explanations (workspace-scoped by hold id) in one round trip
  const [v, tz, rows] = await Promise.all([repo.view(rawId), timezone(deps, ws), repo.explanations(rawId)]);
  if (v === null) return null;
  const [tracking, completed, guidance] = await Promise.all([
    trackingSummaries(deps.db, ws, [v], tz),
    completedSummaries(deps.db, ws, [v]),
    holdGuidance(deps.db, ws, [v]),
  ]);
  const explanations = rows.flatMap((r) => holdExplanation(r) ?? []);
  return HoldDetailSchema.parse({
    hold: holdItem(
      v,
      tracking.get(v.hold.id) ?? null,
      completed.get(v.hold.id) ?? null,
      guidance.get(v.hold.id) ?? null,
    ),
    payment: { id: v.payment.id, status: v.payment.status, statusReason: v.payment.statusReason },
    workspace: { timezone: tz },
    explanations,
  });
}
