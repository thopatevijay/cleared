// The owned test payment over its M1-04 sandbox recording: create (no source, CREATED) → owner claimed
// → confirm card (APPROVED) → capture (COMPLETED), with step-specific PayPal-Request-Ids; then the
// capture GET maps to the mirror the sync job stores.
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/http/client.ts";
import { loadFixture } from "../../src/testing/fixture.ts";
import { startReplay, type Replay } from "../../src/testing/replay.ts";
import { createPayPalCapturesClient } from "../../src/paypal/captures.ts";
import { createPayPalOrdersClient, PAYPAL_SANDBOX_BASE_URL } from "../../src/paypal/orders.ts";
import { createOwnedTestPayment, testPaymentRequestIds } from "../../src/paypal/test-payment.ts";
import { createTokenProvider } from "../../src/paypal/token.ts";

const T = "paypal/orders/test-payment";
let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

function clients() {
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0 });
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials: { clientId: "test-client", clientSecret: "test-secret" },
    cache: new Map(),
  });
  return {
    orders: createPayPalOrdersClient({ http, tokens }),
    captures: createPayPalCapturesClient({ http, tokens }),
  };
}

describe("createOwnedTestPayment (sandbox recording, M1-04)", () => {
  const created = loadFixture(`${T}/create`);
  const requestId = created.request.headers["paypal-request-id"] ?? "";
  const workspaceId = (created.request.body as { purchase_units: { custom_id: string }[] }).purchase_units[0]
    ?.custom_id;

  it("claims the order before any capture exists, then confirms the card and captures", async () => {
    replay = startReplay(["paypal/oauth/token-m1-04", `${T}/create`, `${T}/confirm`, `${T}/capture`]);
    const { orders } = clients();
    const steps: string[] = [];
    const wrapped = {
      ...orders,
      confirmCard: (...a: Parameters<typeof orders.confirmCard>) => {
        steps.push(`confirm:${a[2]}`);
        return orders.confirmCard(...a);
      },
      captureOrder: (...a: Parameters<typeof orders.captureOrder>) => {
        steps.push(`capture:${a[1]}`);
        return orders.captureOrder(...a);
      },
    };
    const out = await createOwnedTestPayment(
      {
        orders: wrapped,
        claimOrder: (orderId, ws) => {
          steps.push(`claim:${orderId}:${ws}`);
          return Promise.resolve();
        },
      },
      { workspaceId: workspaceId ?? "", requestId },
    );
    const ids = testPaymentRequestIds(requestId);
    expect(out).toEqual({
      orderId: "662632381Y533430H",
      captureId: "2FB27654CR016344S",
      status: "COMPLETED",
    });
    expect(steps).toEqual([
      `claim:662632381Y533430H:${workspaceId ?? ""}`,
      `confirm:${ids.confirm}`,
      `capture:${ids.capture}`,
    ]);
    expect(replay.unused()).toEqual([]);
    expect(replay.unmatched()).toEqual([]);
  });

  it("the capture carries custom_id = workspace id and maps to the payment mirror", async () => {
    replay = startReplay(["paypal/oauth/token-m1-04", `${T}/get-capture`]);
    const got = await clients().captures.getCapture("2FB27654CR016344S");
    expect(got.mirror).toMatchObject({
      captureId: "2FB27654CR016344S",
      orderId: "662632381Y533430H",
      customId: workspaceId,
      amount: { amount: "42.00", currency: "USD" },
      receivable: { amount: "40.42", currency: "USD" },
      state: { status: { kind: "known", value: "COMPLETED" }, reason: null },
    });
  });

  it("a capture id that is not a PayPal id is refused before any request", async () => {
    await expect(clients().captures.getCapture("../x")).rejects.toThrow(/invalid capture id/);
  });
});
