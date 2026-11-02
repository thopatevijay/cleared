// M3-04 local E2E support: service holds seeded directly (the sandbox can't produce one; synthetic data), and
// the ui-reviewer captures under .review/M3-04/ (gitignored).
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { seedServiceHold, type SeededServiceHold } from "../../test/support/completed-seed.ts";

export const REVIEW_COMPLETED = fileURLToPath(new URL("../../../../.review/M3-04/", import.meta.url));

export async function seedService(ws: string, seenAt?: Date): Promise<SeededServiceHold> {
  const db = createDb(databaseUrl());
  try {
    return await seedServiceHold(db, ws, { amount: "120.00", ...(seenAt === undefined ? {} : { seenAt }) });
  } finally {
    await closeDb(db);
  }
}
