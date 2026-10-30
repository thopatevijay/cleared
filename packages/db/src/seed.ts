// Idempotent seed: one synthetic seller workspace and its user, no PayPal data (PROJECT.md §9.1:
// personal data is synthetic). A second run inserts nothing.
// Usage: `pnpm --filter @cleared/db run seed` (reads DATABASE_URL; see `databaseUrl`).
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl, type Db } from "./client.ts";
import { users, workspaces } from "../schema/index.ts";

export const SEED_WORKSPACE_ID = "00000000-0000-4000-8000-00000000a5a1";
export const SEED_USER_ID = "00000000-0000-4000-8000-00000000a5a2";
export const SEED_USER_EMAIL = "asha@example.test";

/** Returns how many rows this run inserted (0 on a re-run). */
export async function seed(db: Db): Promise<{ workspaces: number; users: number }> {
  return db.transaction(async (tx) => {
    const ws = await tx
      .insert(workspaces)
      .values({
        id: SEED_WORKSPACE_ID,
        kind: "seller",
        locale: "hi",
        timezone: "Asia/Kolkata",
        baseCurrency: "INR",
      })
      .onConflictDoNothing()
      .returning({ id: workspaces.id });
    const us = await tx
      .insert(users)
      .values({
        id: SEED_USER_ID,
        workspaceId: SEED_WORKSPACE_ID,
        email: SEED_USER_EMAIL,
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    return { workspaces: ws.length, users: us.length };
  });
}

async function main(): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    const inserted = await seed(db);
    console.log(JSON.stringify({ service: "db", msg: "seed applied", inserted }));
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
