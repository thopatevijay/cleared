// GET /api/payments and POST /api/sandbox/test-payments (M1-07). Both act on the session's workspace
// only; any workspace id in the query or body is ignored.
import { randomUUID } from "node:crypto";
import {
  isProofReady,
  packSummary,
  packViewState,
  PaymentsQuerySchema,
  TEST_PAYMENTS_PER_DAY,
  type PaymentItem,
  type PaymentPack,
  type PaymentsResponse,
  type TrackingSummary,
  type WorkspaceId,
} from "@cleared/core";
import {
  holdsRepo,
  packReadsRepo,
  platform,
  type HoldRow,
  type PackStatus,
  SANDBOX_TEST_PAYMENT_QUEUE,
  withTransaction,
  workspaceViews,
  type Publisher,
} from "@cleared/db";
import { checkMutation } from "../csrf.ts";
import { holdGuidance, type HoldGuidance } from "../holds/declaration.ts";
import { paymentHold } from "../holds/read.ts";
import { trackingSummaries } from "../tracking/summaries.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";

export const TEST_PAYMENT_ROUTE = "POST /api/sandbox/test-payments";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A requested test payment counts as "waiting" for this long (M1-04 measured arrival: 27–46 s). */
export const WAITING_WINDOW_MS = 15 * 60 * 1000;

type PaymentRow = Awaited<ReturnType<ReturnType<typeof workspaceViews>["paymentsList"]["page"]>>[number];

function toPack(st: PackStatus | undefined): PaymentPack | null {
  if (st === undefined) return null;
  const s = packSummary(st.latest);
  return {
    id: st.packId,
    view: packViewState(st),
    hasEvidence: st.kinds.length > 0,
    proofReady: isProofReady(st.state, st.latest),
    summary: s === null ? null : { scope: s.scope, delivery: s.delivery, sources: s.sources },
  };
}

function toItem(
  p: PaymentRow,
  pack: PackStatus | undefined,
  hold: HoldRow | undefined,
  tracking: TrackingSummary | null,
  guidance: HoldGuidance | null = null,
): PaymentItem {
  return {
    id: p.id,
    captureId: p.captureId,
    amount: { value: p.amount, currency: p.currency },
    receivable:
      p.receivableAmount !== null && p.receivableCurrency !== null
        ? { value: p.receivableAmount, currency: p.receivableCurrency }
        : null,
    status: p.status,
    statusReason: p.statusReason,
    source: p.source,
    updatedAt: (p.paypalUpdatedAt ?? p.createdAt).toISOString(),
    pack: toPack(pack),
    hold: hold === undefined ? null : paymentHold(hold, tracking, guidance),
  };
}

export async function getPayments(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const params = new URL(req.url).searchParams;
  const q = PaymentsQuerySchema.safeParse({ offset: params.get("offset"), limit: params.get("limit") });
  if (!q.success) {
    return apiError(
      400,
      "invalid_request",
      "offset must be ≥ 0 and limit between 1 and 50.",
      correlationId(req),
    );
  }
  const ws = await platform(deps.db).workspaces.get(session.workspaceId);
  if (ws === null) {
    return apiError(401, "unauthenticated", "Sign in or start a demo to continue.", correlationId(req));
  }
  const v = workspaceViews(deps.db, session.workspaceId as WorkspaceId);
  const now = deps.now().getTime();
  const holds = holdsRepo(deps.db, session.workspaceId);
  const [rows, total, held, today, recent] = await Promise.all([
    v.paymentsList.page(q.data.offset, q.data.limit),
    v.paymentsList.count(),
    // M3-01 (dashboard.md 3a): the held total counts active derived holds only, per currency
    holds.heldTotals(),
    v.testPaymentRequests.since(new Date(now - DAY_MS)),
    v.testPaymentRequests.since(new Date(now - WAITING_WINDOW_MS)),
  ]);
  const packs = packReadsRepo(deps.db, session.workspaceId as WorkspaceId);
  const [arrived, packOf, proofReady, holdOf] = await Promise.all([
    recent.oldest === null ? 0 : v.paymentsList.countCreatedSince(recent.oldest),
    packs.forPayments(rows.map((r) => r.id)),
    packs.proofReadyCount(),
    holds.activeByPayment(rows.map((r) => r.id)),
  ]);
  // M3-03: route advice + tracking state on goods holds (dashboard.md elements 10–12); BL-01 6570499264:
  // the seller's declaration and the guided action it selects
  const refs = rows.flatMap((p) => {
    const hold = holdOf.get(p.id);
    return hold === undefined ? [] : [{ hold, payment: p }];
  });
  const [tracking, guidance] = await Promise.all([
    trackingSummaries(deps.db, session.workspaceId, refs, ws.timezone),
    holdGuidance(deps.db, session.workspaceId, refs),
  ]);
  const body: PaymentsResponse = {
    items: rows.map((r) => {
      const hold = holdOf.get(r.id);
      if (hold === undefined) return toItem(r, packOf.get(r.id), undefined, null);
      return toItem(r, packOf.get(r.id), hold, tracking.get(hold.id) ?? null, guidance.get(hold.id) ?? null);
    }),
    total,
    offset: q.data.offset,
    limit: q.data.limit,
    summary: { held, inDispute: null, proofReady },
    workspace: { kind: ws.kind, timezone: ws.timezone },
    testPayments: {
      waiting: Math.max(0, recent.n - arrived),
      usedToday: today.n,
      limit: TEST_PAYMENTS_PER_DAY,
    },
  };
  return withRenewal(json(body), session);
}

/**
 * Enqueues `sandbox.test_payment` (M1-04) for the session's workspace, at most 3 per rolling 24 h. The
 * audit row (the cap's counter) and the job commit in one transaction, under a per-workspace lock.
 */
export async function postTestPayment(
  req: Request,
  deps: Deps,
  publisher: () => Promise<Publisher>,
): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") {
    return apiError(404, "not_found", "Sandbox test payments are not available.", correlationId(req));
  }
  const scope = { scopeId: session.sessionId, route: TEST_PAYMENT_ROUTE, key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, async () => {
    const pub = await publisher();
    const v = workspaceViews(deps.db, session.workspaceId as WorkspaceId);
    const since = new Date(deps.now().getTime() - DAY_MS);
    const messageId = randomUUID();
    const out = await withTransaction(deps.db, async (tx) => {
      await v.testPaymentRequests.lock(tx);
      const used = await v.testPaymentRequests.since(since, tx);
      if (used.n >= TEST_PAYMENTS_PER_DAY) return "capped" as const;
      await v.testPaymentRequests.record(messageId, tx);
      await pub.enqueue(
        tx,
        SANDBOX_TEST_PAYMENT_QUEUE,
        { workspaceId: session.workspaceId },
        { messageId, workspaceId: session.workspaceId },
      );
      return "queued" as const;
    });
    if (out === "capped") {
      return apiError(
        429,
        "test_payment_limit",
        `This workspace has made ${String(TEST_PAYMENTS_PER_DAY)} test payments in the last 24 hours.`,
        correlationId(req),
      );
    }
    return withRenewal(json({ status: "queued", messageId }, 202), session);
  });
}
