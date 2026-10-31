// M2-10: the judge scenario's sandbox chargeback, at most once per capture. Disputes v1 does not treat a
// repeated `PayPal-Request-Id` as idempotent (M0-05), so a retried job first lists the capture's disputes
// (`disputed_transaction_id`) and adopts one that already exists instead of filing a second chargeback.
import type { Money } from "./schemas.ts";
import type { PayPalDisputesClient } from "./disputes.ts";

export interface ScenarioChargebackInput {
  readonly captureId: string;
  readonly amount: Money;
  /** the order's `payee.merchant_id` */
  readonly merchantId: string;
  readonly requestId: string;
}

export interface ScenarioChargeback {
  readonly disputeId: string;
  /** true when a dispute on this capture already existed (a retry after an earlier call landed) */
  readonly adopted: boolean;
}

export async function openScenarioChargeback(
  disputes: Pick<PayPalDisputesClient, "listDisputes" | "processChargeback">,
  input: ScenarioChargebackInput,
): Promise<ScenarioChargeback> {
  const existing = await disputes.listDisputes({ disputedTransactionId: input.captureId });
  const first = existing.items[0];
  if (first !== undefined) return { disputeId: first.dispute_id, adopted: true };
  const created = await disputes.processChargeback({
    captureId: input.captureId,
    amount: input.amount,
    merchantId: input.merchantId,
    requestId: input.requestId,
  });
  return { disputeId: created.dispute_id, adopted: false };
}
