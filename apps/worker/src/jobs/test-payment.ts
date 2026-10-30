// `sandbox.test_payment` (M1-04; M1-07 adds the UI trigger, M2-10 reuses it): a real sandbox card
// payment owned by the workspace. The owner row is written on the pool, not the consumer transaction,
// so it is committed before the capture exists (the capture's webhook arrives 7–14 s later). The job
// messageId is the PayPal-Request-Id root, so a retried job replays PayPal's first result.
import { createOwnedTestPayment, type OwnedTestPayment, type PayPalOrdersClient } from "@cleared/adapters";
import { platform, type Db } from "@cleared/db";
import { z } from "zod";
import type { Handler } from "../consume.ts";

export const TestPaymentInputSchema = z.object({
  workspaceId: z.uuid(),
  amount: z
    .object({ currency_code: z.string().length(3), value: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/) })
    .optional(),
});
export type TestPaymentInput = z.infer<typeof TestPaymentInputSchema>;

export interface TestPaymentDeps {
  readonly db: Db;
  readonly orders: PayPalOrdersClient;
}

/** Runs the 3-step owned payment for an existing workspace; `requestId` is the idempotency root. */
export async function runTestPayment(
  deps: TestPaymentDeps,
  input: TestPaymentInput,
  requestId: string,
): Promise<OwnedTestPayment> {
  const repos = platform(deps.db);
  if ((await repos.workspaces.get(input.workspaceId)) === null) {
    throw new Error(`workspace ${input.workspaceId} does not exist`);
  }
  return createOwnedTestPayment(
    {
      orders: deps.orders,
      claimOrder: async (orderId, workspaceId) => {
        await repos.resourceOwners.claim({ resourceType: "order", resourceId: orderId, workspaceId });
      },
    },
    {
      workspaceId: input.workspaceId,
      requestId,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
    },
  );
}

export function testPaymentHandler(deps: TestPaymentDeps): Handler {
  return async (data, { envelope, log }) => {
    const out = await runTestPayment(deps, TestPaymentInputSchema.parse(data), envelope.messageId);
    log.info({ ...out }, "sandbox test payment captured");
  };
}
