// M3-04 test and E2E support: a service hold (the M3-01 held payment, typed `service`). Synthetic (data
// policy): `deriveHold` never yields a service hold and the sandbox can't produce one (BL-01 6570499264,
// M3-11), so the hold row is retyped directly, as M3-03's goods seed does.
import { WorkspaceIdSchema } from "@cleared/core";
import { forWorkspace, type Db } from "@cleared/db";
import { seedHeldPayment, type HeldPaymentOptions } from "./hold-seed.ts";

export interface SeededServiceHold {
  readonly holdId: string;
  readonly paymentId: string;
  readonly captureId: string;
}

export async function seedServiceHold(
  db: Db,
  ws: string,
  o: Pick<HeldPaymentOptions, "amount" | "seenAt"> = {},
): Promise<SeededServiceHold> {
  const s = await seedHeldPayment(db, ws, { reason: "OTHER", ...o });
  if (s.holdId === null) throw new Error("no hold derived");
  await forWorkspace(db, WorkspaceIdSchema.parse(ws)).holds.update(s.holdId, { type: "service" });
  return { holdId: s.holdId, paymentId: s.paymentId, captureId: s.captureId };
}
