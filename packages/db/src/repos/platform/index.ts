// `platform(db)`: tables that are not workspace-scoped, plus the pre-workspace lookups (token hash,
// email, workspace creation). Never hand these rows to a client without checking their workspace_id.
import type { Db } from "../../client.ts";
import { identityRepo, idempotencyKeysRepo, workspacesRepo } from "./accounts.ts";
import { authRepo } from "./auth.ts";
import { platformFlagsRepo } from "./flags.ts";
import { resourceOwnersRepo, webhookEventsRepo } from "./ingest.ts";
import { consumerReceiptsRepo, outboxRepo, workerHeartbeatsRepo } from "./messaging.ts";
import { disputeDeadlinesRepo } from "../workspace/disputes.ts";

export function platform(db: Db) {
  return {
    workspaces: workspacesRepo(db),
    identity: identityRepo(db),
    idempotencyKeys: idempotencyKeysRepo(db),
    auth: authRepo(db),
    webhookEvents: webhookEventsRepo(db),
    resourceOwners: resourceOwnersRepo(db),
    outbox: outboxRepo(db),
    consumerReceipts: consumerReceiptsRepo(db),
    workerHeartbeats: workerHeartbeatsRepo(db),
    disputeDeadlines: disputeDeadlinesRepo(db),
    flags: platformFlagsRepo(db),
  };
}

export type PlatformRepos = ReturnType<typeof platform>;

export type * from "./accounts.ts";
export type * from "./auth.ts";
export type * from "./ingest.ts";
export type * from "./messaging.ts";
export type * from "./flags.ts";
