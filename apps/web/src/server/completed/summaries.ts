// M3-04: the guided Completed step's summary on each service hold: the seller's confirmation, the PayPal
// Activity link on the host for PAYPAL_ENV, and where the secondary `record_service_completed` action
// stands (the newest one on the capture). Only service holds get one.
import {
  completedRecordState,
  PAYPAL_ENVS,
  paypalActivityUrl,
  type CompletedSummary,
  type PayPalEnv,
} from "@cleared/core";
import { executionForAction, trackingReads, type Db, type HoldRow } from "@cleared/db";

export interface ServiceHoldRef {
  readonly hold: Pick<HoldRow, "id" | "type" | "completedConfirmedAt">;
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
  const service = refs.filter((r) => r.hold.type === "service");
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
      const response = (exec?.response ?? null) as { trackerStatus?: unknown } | null;
      const summary: CompletedSummary = {
        confirmedAt: r.hold.completedConfirmedAt?.toISOString() ?? null,
        activityUrl: paypalActivityUrl(env),
        env,
        record: {
          state,
          actionId: live?.id ?? null,
          debugId: exec?.paypalDebugId ?? null,
          readBack: typeof response?.trackerStatus === "string" ? response.trackerStatus : null,
          refusal: live?.refusalCode ?? null,
        },
      };
      return [r.hold.id, summary] as const;
    }),
  );
  return new Map(entries);
}
