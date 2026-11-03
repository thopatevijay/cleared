// Load-test workspaces (M4-06): created server-side by the seed CLI (`seed.ts --loadtest N`), never through
// POST /api/demo, so the public per-IP caps and the judge pool are untouched. Each one is a `demo` workspace
// flagged `synthetic` (outside the demo caps and the SLO samples) and tagged by `created_ip_hash =
// 'loadtest'` (an HMAC is 64 hex characters, so the tag can't collide), with no AI budget.
// Its rows are what the product's syncs leave for three captures, shaped from the recorded sandbox ones:
// a COMPLETED payment, a PENDING / PENDING_REVIEW review hold (fixtures/paypal/captures/pending-review.json)
// and a PENDING / BUYER_COMPLAINT payment with its WAITING_FOR_SELLER_RESPONSE dispute
// (fixtures/paypal/disputes/full). None of them gets a `paypal_resource_owner` claim, so the reconcile poll
// never fetches them: a load run makes no PayPal call. Personal data: none (synthetic evidence text only).
import { createHash, randomBytes } from "node:crypto";
import { deriveHold, fromEpochMs, WorkspaceIdSchema } from "@cleared/core";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { purgeSyntheticWorkspace } from "./repos/platform/ops.ts";
import { platform } from "./repos/platform/index.ts";
import { forWorkspace } from "./repos/workspace/index.ts";
import { withTransaction, type Tx } from "./tx.ts";
import { workspaces } from "../schema/index.ts";

export const LOADTEST_TAG = "loadtest";
/** A load-test workspace lives at most this long if its purge never runs. */
export const LOADTEST_TTL_MS = 2 * 60 * 60_000;

export interface LoadtestWorkspace {
  readonly workspaceId: string;
  /** the session cookie value (43 base64url characters); only its sha256 is stored */
  readonly token: string;
  readonly paymentIds: readonly string[];
  readonly packIds: readonly string[];
  readonly holdIds: readonly string[];
  readonly disputeIds: readonly string[];
}

const captureId = (): string => `LT${randomBytes(8).toString("hex").toUpperCase().slice(0, 15)}`;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const EVIDENCE = [
  { kind: "scope", text: "Load-test scope note: one logo in SVG and PNG, final files due in two weeks." },
  { kind: "delivery", text: "Load-test delivery note: logo files uploaded to the shared folder." },
] as const;

export async function createLoadtestWorkspaces(db: Db, n: number, now = new Date()): Promise<LoadtestWorkspace[]> {
  const out: LoadtestWorkspace[] = [];
  for (let i = 0; i < n; i += 1) out.push(await withTransaction(db, (tx) => createOne(db, tx, now)));
  return out;
}

async function createOne(db: Db, tx: Tx, now: Date): Promise<LoadtestWorkspace> {
  const p = platform(db);
  const expiresAt = new Date(now.getTime() + LOADTEST_TTL_MS);
  const ws = await p.workspaces.create(
    {
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
      synthetic: true,
      expiresAt,
      createdIpHash: LOADTEST_TAG,
      llmBudgetUsd: "0",
    },
    tx,
  );
  const token = randomBytes(32).toString("base64url");
  await p.auth.createSession(
    { workspaceId: ws.id, userId: null, kind: "demo", tokenHash: sha256(token), expiresAt, lastSeenAt: now },
    tx,
  );
  const r = forWorkspace(db, WorkspaceIdSchema.parse(ws.id));
  const seenAt = new Date(now.getTime() - 3_600_000);
  const pay = (status: string, statusReason: string | null, amount: string) =>
    r.payments.insert(
      { captureId: captureId(), amount, currency: "USD", status, statusReason, source: "webhook", paypalUpdatedAt: seenAt },
      tx,
    );
  const completed = await pay("COMPLETED", null, "120.00");
  const held = await pay("PENDING", "PENDING_REVIEW", "64.00");
  const disputed = await pay("PENDING", "BUYER_COMPLAINT", "120.00");
  const packIds: string[] = [];
  for (const payment of [completed, held, disputed]) {
    packIds.push((await r.proofPacks.insert({ paymentId: payment.id }, tx)).id);
  }
  for (const e of EVIDENCE) {
    await r.evidenceItems.insert({ packId: packIds[2] ?? "", kind: e.kind, text: e.text, sha256: sha256(e.text) }, tx);
  }
  const dispute = await r.disputes.insert(
    {
      disputeId: `PP-D-LT-${randomBytes(5).toString("hex").toUpperCase()}`,
      paymentId: disputed.id,
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      stage: "INQUIRY",
      status: "WAITING_FOR_SELLER_RESPONSE",
      sellerResponseDueDate: new Date(now.getTime() + 5 * 86_400_000),
      amount: "120.00",
      currency: "USD",
      allowedActions: ["accept_claim", "provide_evidence"],
      paypalUpdatedAt: seenAt,
    },
    tx,
  );
  const holdIds: string[] = [];
  for (const [payment, linked] of [
    [held, null],
    [disputed, dispute],
  ] as const) {
    const d = deriveHold(
      { status: payment.status, reason: payment.statusReason, updateTime: fromEpochMs(seenAt.getTime()) },
      linked === null
        ? null
        : {
            disputeId: linked.disputeId,
            status: linked.status,
            sellerResponseDueDate: fromEpochMs((linked.sellerResponseDueDate ?? now).getTime()),
          },
    );
    if (d === null) continue;
    const h = await r.holds.insert(
      {
        paymentId: payment.id,
        type: d.type,
        reason: d.reason,
        openedAt: new Date(d.openedAt),
        estimatedReleaseAt: d.estimatedReleaseAt === null ? null : new Date(d.estimatedReleaseAt),
        estimateSource: d.estimateRuleId,
      },
      tx,
    );
    holdIds.push(h.id);
  }
  return {
    workspaceId: ws.id,
    token,
    paymentIds: [completed.id, held.id, disputed.id],
    packIds,
    holdIds,
    disputeIds: [dispute.id],
  };
}

const tagged = and(eq(workspaces.createdIpHash, LOADTEST_TAG), eq(workspaces.synthetic, true));

export async function countLoadtestWorkspaces(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(workspaces).where(tagged);
  return rows[0]?.n ?? 0;
}

/**
 * Purges every load-test workspace: its rows (the M3-09 synthetic purge, guards lifted for that transaction
 * only), then the workspace row itself, which the synthetic purge keeps for its agent runs (a load-test
 * workspace has none: no AI budget). Returns the workspaces removed.
 */
export async function purgeLoadtestWorkspaces(db: Db): Promise<{ workspaces: number; rows: number }> {
  const ids = await db.select({ id: workspaces.id }).from(workspaces).where(tagged);
  let rows = 0;
  for (const { id } of ids) {
    rows += await withTransaction(db, async (tx) => {
      const n = await purgeSyntheticWorkspace(id, tx);
      await tx.delete(workspaces).where(and(eq(workspaces.id, id), tagged));
      return n + 1;
    });
  }
  return { workspaces: ids.length, rows };
}
