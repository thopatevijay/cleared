// Drizzle client, migrations and the pg-boss queue (M0-03); workspace-scoped and platform
// repositories, transactions and the seed (M1-02). Apps import only this entry point (eslint rule).
import { CORE_PACKAGE } from "@cleared/core";

export const DB_PACKAGE = "@cleared/db";
export const dependsOn: readonly string[] = [CORE_PACKAGE];

export { closeDb, createDb, databaseUrl, LOCAL_DATABASE_URL, POOL_MAX, type Db } from "./client.ts";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";
export {
  createQueue,
  installQueueSchema,
  jobDb,
  QUEUE_POOL_MAX,
  QUEUE_SCHEMA,
  type Job,
  type JobWithMetadata,
  type CreateQueueOptions,
  type Queue,
} from "./queue.ts";
export * from "./queue-policy.ts";
export { withTransaction, type Executor, type Tx } from "./tx.ts";
export {
  forWorkspace,
  workspaceViews,
  type WorkspaceViews,
  WORKSPACE_REPO_NAMES,
  type ListOptions,
  type MutableScopedRepo,
  type NewRow,
  type Row,
  type RowPatch,
  type ScopedRepo,
  type WorkspaceRepos,
} from "./repos/workspace/index.ts";
export {
  evidenceRepo,
  EVIDENCE_LIST_MAX,
  type BlobRow,
  type EvidenceItemRow,
  type EvidenceListRow,
  type EvidenceRepo,
  type ProofPackRow,
} from "./repos/workspace/evidence.ts";
export { TEST_PAYMENT_REQUESTED, type CurrencyTotal } from "./repos/workspace/payments-list.ts";
export type { DisputeRow, WatchedDispute } from "./repos/workspace/disputes.ts";
export { platform, type PlatformRepos } from "./repos/platform/index.ts";
export type * from "./repos/platform/index.ts";
export { seed, SEED_USER_EMAIL, SEED_USER_ID, SEED_WORKSPACE_ID } from "./seed.ts";
export { WEBHOOK_EVENT_STATUSES, type WebhookEventStatus } from "../schema/enums.ts";
export * from "./outbox/index.ts";
export { pingDb, pingQueue } from "./health.ts";
export { createRunStore } from "./repositories/agent-runs.ts";
export {
  insertProposedAction,
  insertProposedActions,
  type NewProposal,
} from "./repositories/proposed-actions.ts";
export {
  getProposedAction,
  insertSellerProposal,
  setProposedActionState,
  type ProposedActionRow,
  type SellerProposal,
} from "./repositories/proposed-actions.ts";
export {
  approvalForAction,
  approveProposedAction,
  insertApproval,
  rejectProposedAction,
  type ApprovalRow,
  type ApproveRequest,
  type Decision,
  type DecisionResult,
  type NewApproval,
} from "./repositories/approvals.ts";
export {
  claimExecution,
  executionForAction,
  recordExecutionOutcome,
  type ExecutionOutcome,
  type ExecutionRow,
} from "./repositories/executions.ts";
export {
  actionAuditTrail,
  appendActionAudit,
  type ActionAuditEntry,
  type ActionAuditRow,
} from "./repositories/audit-log.ts";
export {
  extractedFactsRepo,
  type ExtractedFactsRepo,
  type ExtractedFactsRow,
  type NewExtractedFacts,
} from "./repositories/extracted-facts.ts";
export {
  scopeChecksRepo,
  type NewScopeCheck,
  type NewScopeLine,
  type ScopeCheckRow,
  type ScopeChecksRepo,
} from "./repositories/scope-checks.ts";
