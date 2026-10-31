// The worker's PayPal clients (one HTTP client and token provider per process, ADR 0011). Built from
// the environment; without credentials the worker still boots and the PayPal jobs fail (and retry)
// with a clear error, so a misconfigured deploy shows up in the logs instead of a crash loop.
import {
  createHttpClient,
  createPayPalCapturesClient,
  createPayPalDisputesClient,
  createPayPalOrdersClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
  type PayPalCapturesClient,
  type PayPalDisputesClient,
  type PayPalOrdersClient,
} from "@cleared/adapters";

export interface PayPalClients {
  readonly orders: PayPalOrdersClient;
  readonly captures: PayPalCapturesClient;
  /** M2-06: dispute reads for `paypal.dispute.sync`; M2-08: the guarded writes `action.execute` makes. */
  readonly disputes: Pick<
    PayPalDisputesClient,
    "getDispute" | "listDisputes" | "provideEvidence" | "provideSupportingInfo" | "acceptClaim"
  >;
}

export function paypalClientsFromEnv(env: NodeJS.ProcessEnv): PayPalClients {
  if ((env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("only PAYPAL_ENV=sandbox is supported");
  const clientId = env["PAYPAL_CLIENT_ID"] ?? "";
  const clientSecret = env["PAYPAL_CLIENT_SECRET"] ?? "";
  const http = createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  if (clientId === "" || clientSecret === "") {
    const missing = (): Promise<never> =>
      Promise.reject(new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set"));
    return {
      captures: { getCapture: missing },
      disputes: {
        getDispute: missing,
        listDisputes: missing,
        provideEvidence: missing,
        provideSupportingInfo: missing,
        acceptClaim: missing,
      },
      orders: {
        createOrder: missing,
        captureOrder: missing,
        confirmCard: missing,
        getOrder: missing,
        getCapture: missing,
        trackOrder: missing,
        markCompleted: missing,
        getLegacyTracker: missing,
      },
    };
  }
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials: { clientId, clientSecret },
  });
  return {
    orders: createPayPalOrdersClient({ http, tokens }),
    captures: createPayPalCapturesClient({ http, tokens }),
    disputes: createPayPalDisputesClient({ http, tokens }),
  };
}
