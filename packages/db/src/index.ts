// Drizzle client, migrations and the pg-boss queue (M0-03); workspace-scoped and platform
// repositories, transactions and the seed (M1-02). Apps import only this entry point (eslint rule).
import { CORE_PACKAGE } from "@cleared/core";

export const DB_PACKAGE = "@cleared/db";
export const dependsOn: readonly string[] = [CORE_PACKAGE];

export { closeDb, createDb, databaseUrl, LOCAL_DATABASE_URL, POOL_MAX, type Db } from "./client.ts";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";
export { createQueue, installQueueSchema, jobDb, QUEUE_POOL_MAX, QUEUE_SCHEMA, type Queue } from "./queue.ts";
export { withTransaction, type Executor, type Tx } from "./tx.ts";
export {
  forWorkspace,
  WORKSPACE_REPO_NAMES,
  type ListOptions,
  type MutableScopedRepo,
  type NewRow,
  type Row,
  type RowPatch,
  type ScopedRepo,
  type WorkspaceRepos,
} from "./repos/workspace/index.ts";
export { platform, type PlatformRepos } from "./repos/platform/index.ts";
export type * from "./repos/platform/index.ts";
export { seed, SEED_USER_EMAIL, SEED_USER_ID, SEED_WORKSPACE_ID } from "./seed.ts";
export { WEBHOOK_EVENT_STATUSES, type WebhookEventStatus } from "../schema/enums.ts";
export * from "./outbox/index.ts";
