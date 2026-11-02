// The review-hold pool's operations (M3-10, ADR 0019), shared by `cli/pool.ts` and its tests:
// - create: PayPal-wallet orders owned by the pool workspace (`custom_id` + `paypal_resource_owner` rows,
//   written in one transaction with the pool row), returning the buyer-approval URLs
// - capture: each `APPROVED` order is captured with an idempotency key (the pool row id); the row becomes
//   `held` (PENDING / PENDING_REVIEW) or `not_held` (recorded, never retried), and a `paypal.capture.sync`
//   job is enqueued in the same transaction, so the payment and its hold arrive through the M3-01 path.
//   Held rows are re-read too: one PayPal released (no longer PENDING) becomes `released` and is re-synced.
// - status: the rows with their age and expected release (rule `payment_review`)
// - assign: the video pool's assignment to the owner's recording workspace (judges get theirs on demo creation)
import { randomUUID } from "node:crypto";
import { approvalUrl, firstCapture, type PayPalOrdersClient } from "@cleared/adapters";
import {
  poolCaptureOutcome,
  poolCatalogueItem,
  poolExpectedRelease,
  REVIEW_POOL_RULE_ID,
  type Instant,
  type ReviewPoolPurpose,
} from "@cleared/core";
import {
  PAYPAL_CAPTURE_SYNC_QUEUE,
  platform,
  withTransaction,
  type Db,
  type PoolAssignment,
  type Publisher,
  type ReviewHoldPoolRow,
  type Tx,
} from "@cleared/db";

/** A pool is small (2 judge + 1 video per refill); a larger count is a typo, not a plan. */
export const POOL_MAX_COUNT = 5;

export interface PoolDeps {
  readonly db: Db;
  readonly orders: Pick<PayPalOrdersClient, "createOrder" | "getOrder" | "captureOrder" | "getCapture">;
  readonly publisher: Pick<Publisher, "enqueue">;
  readonly now: () => Date;
}

export interface CreatedPoolOrder {
  readonly orderId: string;
  readonly purpose: ReviewPoolPurpose;
  readonly amount: string;
  readonly approveUrl: string;
}

/** The pool workspace (kind `seller`, no user, no AI budget): the one pool rows name, or a new one. */
export async function poolWorkspace(db: Db, tx?: Tx): Promise<string> {
  const p = platform(db);
  const existing = await p.reviewHoldPool.poolWorkspaceId(tx);
  if (existing !== null) return existing;
  const ws = await p.workspaces.create(
    { kind: "seller", locale: "en", timezone: "UTC", baseCurrency: "USD", llmBudgetUsd: "0" },
    tx,
  );
  return ws.id;
}

export async function createPool(
  deps: PoolDeps,
  input: { readonly count: number; readonly purpose: ReviewPoolPurpose; readonly returnUrl: string },
): Promise<CreatedPoolOrder[]> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > POOL_MAX_COUNT) {
    throw new Error(`--count must be 1..${String(POOL_MAX_COUNT)}`);
  }
  const p = platform(deps.db);
  const workspaceId = await poolWorkspace(deps.db);
  const out: CreatedPoolOrder[] = [];
  for (let i = 0; i < input.count; i++) {
    const item = poolCatalogueItem(i);
    const order = await deps.orders.createOrder({
      amount: { currency_code: "USD", value: item.value },
      customId: workspaceId,
      referenceId: `review-pool-${input.purpose}`,
      description: item.description,
      wallet: { returnUrl: input.returnUrl, cancelUrl: input.returnUrl },
      requestId: randomUUID(),
    });
    const approveUrl = approvalUrl(order);
    if (approveUrl === null) throw new Error(`order ${order.id} has no buyer-approval link`);
    await withTransaction(deps.db, async (tx) => {
      await p.resourceOwners.claim({ resourceType: "order", resourceId: order.id, workspaceId }, tx);
      await p.reviewHoldPool.insert(
        {
          orderId: order.id,
          poolWorkspaceId: workspaceId,
          purpose: input.purpose,
          amount: item.value,
          currency: "USD",
          approveUrl,
        },
        tx,
      );
    });
    out.push({ orderId: order.id, purpose: input.purpose, amount: `${item.value} USD`, approveUrl });
  }
  return out;
}

export interface CaptureResult {
  readonly orderId: string;
  readonly purpose: string;
  /** what this run did */
  readonly result: "held" | "not_held" | "waiting_for_buyer" | "released" | "still_held";
  readonly orderStatus: string | null;
  readonly captureId: string | null;
  readonly captureStatus: string | null;
  readonly captureReason: string | null;
}

export async function capturePool(deps: PoolDeps): Promise<CaptureResult[]> {
  const repo = platform(deps.db).reviewHoldPool;
  const out: CaptureResult[] = [];
  for (const row of await repo.inState(["awaiting_buyer"])) out.push(await captureOne(deps, row));
  for (const row of await repo.inState(["held"])) out.push(await refreshHeld(deps, row));
  return out;
}

const repo = (deps: PoolDeps) => platform(deps.db).reviewHoldPool;

async function captureOne(deps: PoolDeps, row: ReviewHoldPoolRow): Promise<CaptureResult> {
  const base = { orderId: row.orderId, purpose: row.purpose };
  const order = await deps.orders.getOrder(row.orderId);
  let capture = firstCapture(order);
  if (capture === undefined && order.status === "APPROVED") {
    capture = firstCapture(await deps.orders.captureOrder(row.orderId, row.id));
  }
  if (capture === undefined) {
    return {
      ...base,
      result: "waiting_for_buyer",
      orderStatus: order.status,
      captureId: null,
      captureStatus: null,
      captureReason: null,
    };
  }
  const reason = capture.status_details?.reason ?? null;
  const state = poolCaptureOutcome(capture.status, reason);
  const capturedAt = capture.create_time === undefined ? deps.now() : new Date(capture.create_time);
  const captureId = capture.id;
  await withTransaction(deps.db, async (tx) => {
    await repo(deps).markCaptured(
      row.id,
      { captureId, captureStatus: capture.status, captureReason: reason, capturedAt, state },
      tx,
    );
    await enqueueSync(deps, tx, captureId, row.poolWorkspaceId);
  });
  return {
    ...base,
    result: state,
    orderStatus: order.status,
    captureId,
    captureStatus: capture.status,
    captureReason: reason,
  };
}

async function refreshHeld(deps: PoolDeps, row: ReviewHoldPoolRow): Promise<CaptureResult> {
  const captureId = row.captureId ?? "";
  const capture = await deps.orders.getCapture(captureId);
  const reason = capture.status_details?.reason ?? null;
  const base = { orderId: row.orderId, purpose: row.purpose, orderStatus: null, captureId };
  if (capture.status === "PENDING") {
    return { ...base, result: "still_held", captureStatus: capture.status, captureReason: reason };
  }
  await withTransaction(deps.db, async (tx) => {
    await repo(deps).markReleased(row.id, capture.status, tx);
    await enqueueSync(deps, tx, captureId, row.assignedWorkspaceId ?? row.poolWorkspaceId);
  });
  return { ...base, result: "released", captureStatus: capture.status, captureReason: reason };
}

async function enqueueSync(deps: PoolDeps, tx: Tx, captureId: string, workspaceId: string): Promise<void> {
  const data = { captureId, source: "poll" as const };
  await deps.publisher.enqueue(tx, PAYPAL_CAPTURE_SYNC_QUEUE, data, { workspaceId });
}

/** The video pool's assignment (`pool:assign --workspace <id>`); null when no video row is assignable. */
export async function assignVideo(db: Db, workspaceId: string, now: Date): Promise<PoolAssignment | null> {
  if ((await platform(db).workspaces.get(workspaceId)) === null) {
    throw new Error(`workspace ${workspaceId} does not exist`);
  }
  return withTransaction(db, (tx) =>
    platform(db).reviewHoldPool.assign({ workspaceId, purpose: "video", now }, tx),
  );
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${String(Math.round(ms / 60_000))} min` : `${h.toFixed(1)} h`;
}

/** One line per pool row: age, PayPal's state verbatim and the expected release (an estimate, with its rule). */
export function statusTable(rows: readonly ReviewHoldPoolRow[], now: Date): string {
  const header = ["purpose", "state", "order", "capture", "paypal", "age", "expected release", "assigned to"];
  const lines = rows.map((r) => {
    const paypal = r.captureStatus === null ? "-" : `${r.captureStatus}/${r.captureReason ?? "-"}`;
    const age =
      r.capturedAt === null
        ? `created ${hours(now.getTime() - r.createdAt.getTime())} ago`
        : hours(now.getTime() - r.capturedAt.getTime());
    return [
      r.purpose,
      r.state,
      r.orderId,
      r.captureId ?? "-",
      paypal,
      age,
      expected(r),
      r.assignedWorkspaceId ?? "-",
    ];
  });
  const all = [header, ...lines];
  const widths = header.map((_, i) => Math.max(...all.map((l) => (l[i] ?? "").length)));
  const fmt = (l: readonly string[]) =>
    l
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const note = `expected release: about 24 h after capture (estimated, rule ${REVIEW_POOL_RULE_ID}); assignable while under 20 h old`;
  return [fmt(header), ...lines.map(fmt), "", `${String(rows.length)} pool rows · ${note}`].join("\n");
}

function expected(r: ReviewHoldPoolRow): string {
  if (r.state === "released") return "released by PayPal";
  if (r.state !== "held" || r.capturedAt === null) return "-";
  const e = poolExpectedRelease(r.capturedAt.toISOString() as Instant);
  return e === null ? "-" : `~${e.at.slice(0, 16)}Z`;
}
