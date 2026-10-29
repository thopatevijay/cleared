// Drizzle client, migrations and the pg-boss queue (M0-03). Domain tables and repositories: M1-02.
import { CORE_PACKAGE } from "@cleared/core";

export const DB_PACKAGE = "@cleared/db";
export const dependsOn: readonly string[] = [CORE_PACKAGE];

export { closeDb, createDb, databaseUrl, LOCAL_DATABASE_URL, POOL_MAX, type Db } from "./client.ts";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";
export { createQueue, jobDb, QUEUE_POOL_MAX, QUEUE_SCHEMA, type Queue } from "./queue.ts";
