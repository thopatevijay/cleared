// M3-04: the guided Completed step's summary on each service hold: the seller's confirmation, the PayPal
// Activity link on the host for PAYPAL_ENV, and where the secondary `record_service_completed` action
// stands (the newest one on the capture). Only holds whose guided action is Completed get one: a hold PayPal
// typed service, or one the seller declared a service (BL-01 6570499264).
import {
  completedRecordState,
  declaredKindOf,
  guidedAction,
  holdTypeOf,
  PAYPAL_ENVS,
  paypalActivityUrl,
  type CompletedSummary,
  type PayPalEnv,
} from "@cleared/core";
import { executionForAction, trackingReads, type Db, type HoldRow } from "@cleared/db";
import { z } from "zod";

/** The execution row's stored answer (worker record-service-completed.ts): the read-back status. */
const ReadBackSchema = z.object({ trackerStatus: z.string() });

export interface ServiceHoldRef {
  readonly hold: Pick<HoldRow, "id" | "type" | "completedConfirmedAt" | "sellerDeclaredKind">;
  readonly payment: { readonly captureId: string };
}

/** PAYPAL_ENV read per request; anything but "live" is the sandbox (the product is sandbox-only). */
export function currentPayPalEnv(): PayPalEnv {
  const raw = process.env["PAYPAL_ENV"] ?? "sandbox";
  return (PAYPAL_ENVS as readonly string[]).includes(raw) ? (raw as PayPalEnv) : "sandbox";
}

export async function completedSummaries(
  db: Db,
  ws: string,
  refs: readonly ServiceHoldRef[],
): Promise<Map<string, CompletedSummary>> {
  const service = refs.filter(
    (r) => guidedAction(holdTypeOf(r.hold.type), declaredKindOf(r.hold.sellerDeclaredKind)) === "completed",
  );
  if (service.length === 0) return new Map();
  const env = currentPayPalEnv();
  const actions = await trackingReads(db, ws).latestActionsByCapture(
    "record_service_completed",
    service.map((r) => r.payment.captureId),
  );
  const entries = await Promise.all(
    service.map(async (r) => {
      const a = actions.get(r.payment.captureId) ?? null;
      const state = completedRecordState(a?.state ?? null);
      const live = a !== null && state !== "none" ? a : null;
      const exec = live === null ? null : await executionForAction(db, ws, live.id);
      const readBack = ReadBackSchema.safeParse(exec?.response).data?.trackerStatus ?? null;
      const summary: CompletedSummary = {
        confirmedAt: r.hold.completedConfirmedAt?.toISOString() ?? null,
        activityUrl: paypalActivityUrl(env),
        env,
        record: {
          state,
          actionId: live?.id ?? null,
          debugId: exec?.paypalDebugId ?? null,
          readBack,
          refusal: live?.refusalCode ?? null,
        },
      };
      return [r.hold.id, summary] as const;
    }),
  );
  return new Map(entries);
}
