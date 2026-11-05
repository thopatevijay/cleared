// Idempotent seed: one synthetic seller workspace and its user, no PayPal data (data policy:
// personal data is synthetic). A second run inserts nothing.
// Usage: `pnpm --filter @cleared/db run seed` (reads DATABASE_URL; see `databaseUrl`).
// M4-06 load tests (opt-in; the deploy's plain run never takes these):
//   --loadtest <N>     creates N `loadtest` workspaces (loadtest.ts) and prints them, with their session
//                      tokens, as ONE JSON line on stdout for the launcher to read (never log it)
//   --purge loadtest   purges every `loadtest` workspace and prints the counts
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl, type Db } from "./client.ts";
import { createLoadtestWorkspaces, LOADTEST_TAG, purgeLoadtestWorkspaces } from "./loadtest.ts";
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

/** The value after `name` in argv, or undefined. */
function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv: readonly string[]): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    const n = arg(argv, "--loadtest");
    const purge = arg(argv, "--purge");
    if (n !== undefined) {
      const count = Number(n);
      if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error("--loadtest takes 1..200");
      console.log(
        JSON.stringify({ tag: LOADTEST_TAG, workspaces: await createLoadtestWorkspaces(db, count) }),
      );
    } else if (purge !== undefined) {
      if (purge !== LOADTEST_TAG) throw new Error(`--purge only takes "${LOADTEST_TAG}"`);
      const purged = await purgeLoadtestWorkspaces(db);
      console.log(JSON.stringify({ service: "db", msg: "loadtest purged", tag: LOADTEST_TAG, ...purged }));
    } else {
      const inserted = await seed(db);
      console.log(JSON.stringify({ service: "db", msg: "seed applied", inserted }));
    }
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
