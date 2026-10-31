// Sandbox test payment owned by a workspace (M1-04; reused by M1-07 and M2-10). A card order in three
// steps so the owner row exists before any capture does (ADR 0008): create (no payment source, so the
// order stays `CREATED`) → claim the order for the workspace → confirm the sandbox card → capture.
// `custom_id = workspaceId` on the order and its capture. Every write carries a PayPal-Request-Id derived
// from the caller's id (the job messageId), so a retried job replays PayPal's first result instead of
// paying twice.
import type { Money, Order } from "./schemas.ts";
import { firstCapture, type CardSource, type PayPalOrdersClient } from "./orders.ts";

/** PayPal's sandbox test Visa (M0-04): approves without 3-D Secure. */
export const SANDBOX_TEST_CARD: CardSource = {
  number: "4111111111111111",
  expiry: "2030-12",
  securityCode: "123",
  name: "Asha Verma",
};
export const TEST_PAYMENT_AMOUNT: Money = { currency_code: "USD", value: "42.00" };

export interface OwnedTestPaymentDeps {
  readonly orders: Pick<PayPalOrdersClient, "createOrder" | "confirmCard" | "captureOrder">;
  /** Writes `paypal_resource_owner(order, orderId) → workspaceId`; must be committed when it resolves. */
  readonly claimOrder: (orderId: string, workspaceId: string) => Promise<void>;
}

export interface OwnedTestPaymentInput {
  readonly workspaceId: string;
  /** The job messageId (a uuid); the per-step PayPal-Request-Ids derive from it. */
  readonly requestId: string;
  readonly amount?: Money;
}

export interface OwnedTestPayment {
  readonly orderId: string;
  readonly captureId: string;
  readonly status: string;
  /** M2-10: the order's `payee.merchant_id` (the sandbox chargeback needs it); null if PayPal omits it */
  readonly merchantId: string | null;
}

/** The PayPal-Request-Id of each write; distinct per step, stable per caller id. */
export function testPaymentRequestIds(requestId: string) {
  return { create: requestId, confirm: `${requestId}-confirm`, capture: `${requestId}-capture` } as const;
}

export async function createOwnedTestPayment(
  deps: OwnedTestPaymentDeps,
  input: OwnedTestPaymentInput,
): Promise<OwnedTestPayment> {
  const ids = testPaymentRequestIds(input.requestId);
  const created = await deps.orders.createOrder({
    amount: input.amount ?? TEST_PAYMENT_AMOUNT,
    customId: input.workspaceId,
    description: "Cleared sandbox test payment",
    requestId: ids.create,
  });
  await deps.claimOrder(created.id, input.workspaceId);
  if (firstCapture(created) === undefined) {
    if (created.status === "CREATED") {
      await deps.orders.confirmCard(created.id, SANDBOX_TEST_CARD, ids.confirm);
    }
    const captured = await deps.orders.captureOrder(created.id, ids.capture);
    return result(captured.purchase_units[0]?.payee ? captured : created, firstCapture(captured));
  }
  return result(created, firstCapture(created));
}

function result(order: Order, capture: ReturnType<typeof firstCapture>): OwnedTestPayment {
  if (capture === undefined) throw new Error(`order ${order.id} has no capture after capture`);
  const merchantId = order.purchase_units[0]?.payee?.merchant_id ?? null;
  return { orderId: order.id, captureId: capture.id, status: capture.status, merchantId };
}
