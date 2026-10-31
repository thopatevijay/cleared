// `forWorkspace(db, workspaceId)`: the only way an app reads or writes workspace-scoped tables.
// Append-only tables (audit_log, evidence_items) get no `update` (the trigger would refuse it anyway).
import { WorkspaceIdSchema, type WorkspaceId } from "@cleared/core";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { disputesRepo } from "./disputes.ts";
import { paymentsListRepo, testPaymentRequestsRepo } from "./payments-list.ts";
import { scenarioRunsRepo } from "./scenarios.ts";
import { findOneInScope, mutableScopedRepo, scopedRepo, type Row } from "./scoped.ts";

function repos(db: Db, ws: string) {
  const m = <T extends Parameters<typeof mutableScopedRepo>[1]>(t: T) => mutableScopedRepo(db, t, ws);
  return {
    users: m(s.users),
    sessions: m(s.sessions),
    magicLinks: m(s.magicLinks),
    notifications: m(s.notifications),
    payments: {
      ...m(s.payments),
      getByCaptureId: (captureId: string, tx?: Executor): Promise<Row<typeof s.payments> | null> =>
        findOneInScope(tx ?? db, s.payments, ws, s.payments.captureId, captureId),
    },
    holds: m(s.holds),
    explanations: m(s.explanations),
    proofPacks: {
      ...m(s.proofPacks),
      getByPaymentId: (paymentId: string, tx?: Executor): Promise<Row<typeof s.proofPacks> | null> =>
        findOneInScope(tx ?? db, s.proofPacks, ws, s.proofPacks.paymentId, paymentId),
    },
    blobs: m(s.blobs),
    evidenceItems: scopedRepo(db, s.evidenceItems, ws),
    extractedFacts: m(s.extractedFacts),
    scopeChecks: scopedRepo(db, s.scopeChecks, ws),
    clientAcks: m(s.clientAcks),
    disputes: disputesRepo(db, ws),
    disputeDrafts: m(s.disputeDrafts),
    proposedActions: m(s.proposedActions),
    approvals: m(s.approvals),
    executions: m(s.executions),
    auditLog: scopedRepo(db, s.auditLog, ws),
    agentRuns: m(s.agentRuns),
    agentSteps: m(s.agentSteps),
    scenarioRuns: scenarioRunsRepo(db, ws),
  };
}

/** Workspace-scoped read models beyond plain table repos (M1-07); not part of the per-table isolation list. */
export interface WorkspaceViews {
  readonly paymentsList: ReturnType<typeof paymentsListRepo>;
  readonly testPaymentRequests: ReturnType<typeof testPaymentRequestsRepo>;
}

export type WorkspaceRepos = ReturnType<typeof repos> & { readonly workspaceId: WorkspaceId };

/** Every workspace-scoped repository, bound to one workspace. Throws on a non-uuid id. */
export function forWorkspace(db: Db, workspaceId: WorkspaceId): WorkspaceRepos {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  return { workspaceId: ws, ...repos(db, ws) };
}

/** The dashboard's reads and the test-payment counter, bound to one workspace. Throws on a non-uuid id. */
export function workspaceViews(db: Db, workspaceId: WorkspaceId): WorkspaceViews {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  return { paymentsList: paymentsListRepo(db, ws), testPaymentRequests: testPaymentRequestsRepo(db, ws) };
}

/** Names of the workspace-scoped repos (the isolation test iterates over all of them). */
export const WORKSPACE_REPO_NAMES = [
  "users",
  "sessions",
  "magicLinks",
  "notifications",
  "payments",
  "holds",
  "explanations",
  "proofPacks",
  "blobs",
  "evidenceItems",
  "extractedFacts",
  "scopeChecks",
  "clientAcks",
  "disputes",
  "disputeDrafts",
  "proposedActions",
  "approvals",
  "executions",
  "auditLog",
  "agentRuns",
  "agentSteps",
  "scenarioRuns",
] as const satisfies readonly (keyof ReturnType<typeof repos>)[];

export type { ListOptions, MutableScopedRepo, NewRow, Row, RowPatch, ScopedRepo } from "./scoped.ts";
