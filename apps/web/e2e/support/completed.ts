// M3-04 local E2E support: service holds seeded directly (the sandbox can't produce one; synthetic data), a
// `record_service_completed` action left in a given state (to capture the card's recording / failed /
// unknown states without a worker run), and the ui-reviewer captures under .review/M3-04/ (gitignored).
import { fileURLToPath } from "node:url";
import { recordServiceCompletedPayload } from "@cleared/core";
import { closeDb, createDb, databaseUrl, insertSellerProposal, withTransaction } from "@cleared/db";
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

/** A seller's record on the capture, set straight to `state` (no job: nothing will move it). */
export async function seedRecord(
  ws: string,
  captureId: string,
  state: "executing" | "failed" | "unknown",
  code: string | null = null,
): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    const row = await withTransaction(db, (tx) =>
      insertSellerProposal(
        db,
        {
          workspaceId: ws,
          proposedBy: "e2e",
          kind: "record_service_completed",
          payload: recordServiceCompletedPayload(captureId),
        },
        tx,
      ),
    );
    await db.$client.query("update proposed_actions set state = $1, refusal_code = $2 where id = $3", [
      state,
      code,
      row.id,
    ]);
  } finally {
    await closeDb(db);
  }
}
