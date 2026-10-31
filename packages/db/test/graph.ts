// Test helper: a fresh workspace with one row in every workspace-scoped table (synthetic data only).
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceIdSchema } from "@cleared/core";
import type { Db } from "../src/client.ts";
import { platform } from "../src/repos/platform/index.ts";
import {
  forWorkspace,
  type WORKSPACE_REPO_NAMES,
  type WorkspaceRepos,
} from "../src/repos/workspace/index.ts";

export type RepoName = (typeof WORKSPACE_REPO_NAMES)[number];
type Ids = Partial<Record<RepoName, string>>;

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const paypalId = (): string => randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase();

export async function newWorkspace(db: Db): Promise<WorkspaceRepos> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  return forWorkspace(db, WorkspaceIdSchema.parse(ws.id));
}

async function seedAccounts(r: WorkspaceRepos): Promise<Ids & { users: string; agentRuns: string }> {
  const later = new Date(Date.now() + 15 * 60_000);
  const user = await r.users.insert({ email: `${randomUUID()}@example.test` });
  const session = await r.sessions.insert({
    userId: user.id,
    kind: "seller",
    tokenHash: sha(randomUUID()),
    expiresAt: later,
  });
  const link = await r.magicLinks.insert({
    userId: user.id,
    tokenHash: sha(randomUUID()),
    expiresAt: later,
    email: `link-${randomUUID()}@example.test`,
    requestedIpHash: sha(randomUUID()),
  });
  const note = await r.notifications.insert({ kind: "dispute_opened" });
  const run = await r.agentRuns.insert({
    task: "extract",
    inputHash: sha("in"),
    model: "test-model",
    status: "succeeded",
  });
  const step = await r.agentSteps.insert({
    runId: run.id,
    stepIndex: 0,
    task: "extract",
    status: "succeeded",
  });
  const audit = await r.auditLog.insert({ actor: "system", action: "test.seeded" });
  // M2-10: a finished run, so the one-active-run index never collides between graphs
  const scenario = await r.scenarioRuns.insert({ state: "resolved" });
  return {
    scenarioRuns: scenario.id,
    users: user.id,
    sessions: session.id,
    magicLinks: link.id,
    notifications: note.id,
    agentRuns: run.id,
    agentSteps: step.id,
    auditLog: audit.id,
  };
}

async function seedPayment(r: WorkspaceRepos, runId: string): Promise<Ids & { evidenceItems: string }> {
  const payment = await r.payments.insert({
    captureId: paypalId(),
    amount: "42.00",
    currency: "USD",
    status: "PENDING",
    statusReason: "BUYER_COMPLAINT",
    source: "webhook",
  });
  const hold = await r.holds.insert({
    paymentId: payment.id,
    type: "payment_hold",
    reason: "BUYER_COMPLAINT",
    openedAt: new Date(),
  });
  const expl = await r.explanations.insert({
    holdId: hold.id,
    locale: "en",
    text: "held",
    sourceRef: "rule:test",
  });
  const pack = await r.proofPacks.insert({ paymentId: payment.id });
  const pdf = Buffer.from("%PDF-1.4");
  const blob = await r.blobs.insert({
    mime: "application/pdf",
    bytes: pdf,
    size: pdf.length,
    sha256: sha("pdf"),
  });
  const ev = await r.evidenceItems.insert({
    packId: pack.id,
    kind: "delivery",
    blobId: blob.id,
    sha256: sha("pdf"),
  });
  const fact = await r.extractedFacts.insert({
    evidenceItemId: ev.id,
    facts: {},
    model: "test-model",
    runId,
    promptVersion: "extract@v1",
  });
  const check = await r.scopeChecks.insert({
    packId: pack.id,
    line: "3 concepts",
    verdict: "met",
    checkVersion: 1,
    evidenceSetHash: sha("set"),
    promptVersion: "check_scope@v1",
    lineId: "C1",
    modelVerdict: "met",
    rationale: "",
  });
  const ack = await r.clientAcks.insert({ packId: pack.id, tokenHash: sha(randomUUID()) });
  return {
    payments: payment.id,
    holds: hold.id,
    explanations: expl.id,
    proofPacks: pack.id,
    blobs: blob.id,
    evidenceItems: ev.id,
    extractedFacts: fact.id,
    scopeChecks: check.id,
    clientAcks: ack.id,
  };
}

async function seedDispute(
  r: WorkspaceRepos,
  ids: { payments?: string; evidenceItems: string; users: string; agentRuns: string },
): Promise<Ids> {
  const dispute = await r.disputes.insert({
    disputeId: `PP-R-${paypalId()}`,
    paymentId: ids.payments,
    status: "OPEN",
  });
  const draft = await r.disputeDrafts.insert({
    disputeId: dispute.id,
    notes: "synthetic",
    evidenceItemIds: [ids.evidenceItems],
  });
  const action = await r.proposedActions.insert({
    kind: "provide_evidence",
    payload: {},
    payloadSha256: sha("{}"),
    risk: "high",
    createdByRunId: ids.agentRuns,
  });
  const approval = await r.approvals.insert({
    actionId: action.id,
    approvedBy: ids.users,
    payloadSha256: sha("{}"),
  });
  const exec = await r.executions.insert({ actionId: action.id, idempotencyKey: randomUUID() });
  return {
    disputes: dispute.id,
    disputeDrafts: draft.id,
    proposedActions: action.id,
    approvals: approval.id,
    executions: exec.id,
  };
}

/** Inserts one row per workspace-scoped repo; returns each row's id by repo name. */
export async function seedGraph(r: WorkspaceRepos): Promise<Ids> {
  const accounts = await seedAccounts(r);
  const money = await seedPayment(r, accounts.agentRuns);
  const disputes = await seedDispute(r, { ...accounts, ...money });
  return { ...accounts, ...money, ...disputes };
}
