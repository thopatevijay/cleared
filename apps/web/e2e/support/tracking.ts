// M3-03 local E2E support: goods holds seeded directly (the sandbox can't produce one; synthetic data),
// optionally with a shipment evidence item whose facts name the carrier, and the ui-reviewer captures under
// .review/M3-03/ (gitignored).
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import {
  seedGoodsHold,
  type GoodsHoldOptions,
  type SeededGoodsHold,
} from "../../test/support/tracking-seed.ts";

export const REVIEW_TRACKING = fileURLToPath(new URL("../../../../.review/M3-03/", import.meta.url));

export async function seedGoods(ws: string, o: GoodsHoldOptions = {}): Promise<SeededGoodsHold> {
  const db = createDb(databaseUrl());
  try {
    return await seedGoodsHold(db, ws, o);
  } finally {
    await closeDb(db);
  }
}
