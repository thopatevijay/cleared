// M3-02 test support: a workspace with one held payment (claimed by the workspace, as the product path does),
// the hold row written from core's `deriveHold`, and the delivery context the explainer runs in.
// Amounts and buyers are synthetic (PROJECT.md §9.1); the review reason is the recorded PENDING_REVIEW.
import { randomBytes, randomUUID } from "node:crypto";
import { deriveHold, fromEpochMs, WorkspaceIdSchema, type Locale, type WorkspaceId } from "@cleared/core";
import { forWorkspace, platform, type Db } from "@cleared/db";
import { silentLog } from "./extract-support.ts";

export const EXPLAIN_SEEN_AT = new Date("2026-10-26T11:24:21Z");

const created: string[] = [];

export async function explainWorkspace(
  db: Db,
  o: { locale?: Locale; budgetUsd?: string | null } = {},
): Promise<WorkspaceId> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: o.locale ?? "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
    ...(o.budgetUsd === undefined ? {} : { llmBudgetUsd: o.budgetUsd }),
  });
  created.push(ws.id);
  return WorkspaceIdSchema.parse(ws.id);
}

/** A PENDING capture with `reason`, its owner claim and the derived hold (state `open`). */
export async function heldPayment(
  db: Db,
  ws: WorkspaceId,
  reason: "PENDING_REVIEW" | "BUYER_COMPLAINT" = "PENDING_REVIEW",
  amount = "64.00",
): Promise<{ holdId: string; paymentId: string }> {
  const captureId = `M302${randomBytes(6).toString("hex").toUpperCase()}`;
  const repos = forWorkspace(db, ws);
  await platform(db).resourceOwners.claim({
    resourceType: "capture",
    resourceId: captureId,
    workspaceId: ws,
  });
  const p = await repos.payments.insert({
    captureId,
    amount,
    currency: "USD",
    status: "PENDING",
    statusReason: reason,
    source: "webhook",
    paypalUpdatedAt: EXPLAIN_SEEN_AT,
  });
  const d = deriveHold({ status: "PENDING", reason, updateTime: fromEpochMs(EXPLAIN_SEEN_AT.getTime()) });
  if (d === null) throw new Error("not a hold");
  const h = await repos.holds.insert({
    paymentId: p.id,
    state: "open",
    type: d.type,
    reason: d.reason,
    openedAt: new Date(d.openedAt),
    estimatedReleaseAt: d.estimatedReleaseAt === null ? null : new Date(d.estimatedReleaseAt),
    estimateSource: d.estimateRuleId,
  });
  return { holdId: h.id, paymentId: p.id };
}

export function holdEvent(ws: WorkspaceId, holdId: string, locale?: Locale) {
  const base = { version: 1, workspaceId: ws, occurredAt: fromEpochMs(EXPLAIN_SEEN_AT.getTime()) } as const;
  return locale === undefined
    ? { ...base, type: "hold.opened", data: { holdId, captureId: "M302CAPTURE", reason: "PENDING_REVIEW" } }
    : { ...base, type: "hold.explain_requested", data: { holdId, locale } };
}

export const explainCtx = () => ({
  log: silentLog,
  envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
});

/** Deletes the `hold.explained` jobs these tests enqueued (no other suite's worker should consume them). */
export async function deleteExplainJobs(db: Db): Promise<void> {
  await db.$client.query(
    "delete from pgboss.job where name = 'hold.explained' and data->>'workspaceId' = any($1)",
    [created],
  );
}

export async function agentRuns(db: Db, ws: WorkspaceId) {
  const r = await db.$client.query<{
    status: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: string;
    latency_ms: number | null;
    model: string;
  }>(
    "select status, tokens_in, tokens_out, cost_usd::text, latency_ms, model from agent_runs where workspace_id = $1 and task = 'explain_hold' order by created_at",
    [ws],
  );
  return r.rows;
}
