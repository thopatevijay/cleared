// Shared by the M2-06 worker tests: the recorded M0-05 dispute GETs served by msw, rewritten to a fresh
// dispute id and capture id per test (both are unique across the database) and to the test workspace's
// `custom` (in the product `custom_id` = workspace id; the spike recorded its own marker).
import { randomBytes } from "node:crypto";
import {
  createHttpClient,
  createPayPalDisputesClient,
  createTokenProvider,
  type PayPalDisputesClient,
} from "@cleared/adapters";
import { http, HttpResponse } from "msw";
import type { SetupServer } from "msw/node";
import { loadFixture, responseText } from "../../../packages/adapters/src/testing/fixture.ts";

export const FULL = "paypal/disputes/full";
export const STATE = {
  open: `${FULL}/state-1-open`,
  underReview: `${FULL}/state-2-under_review`,
  waiting: `${FULL}/state-3-waiting_for_seller_response`,
  resolved: `${FULL}/state-6-resolved`,
} as const;
/** `seller_response_due_date` of the recorded WAITING_FOR_SELLER_RESPONSE state. */
export const RECORDED_DUE = "2026-11-09T04:59:59.000Z";

export interface Ids {
  readonly disputeId: string;
  readonly captureId: string;
}

export function freshIds(): Ids {
  const hex = randomBytes(6).toString("hex").toUpperCase();
  return { disputeId: `PP-R-TST-${hex}`, captureId: `T${hex}0000X` };
}

/** Serves one dispute GET from `fixture` with the ids (and `custom`) replaced. */
export function serveDispute(server: SetupServer, fixture: string, ids: Ids, custom: string | null): void {
  const f = loadFixture(fixture);
  const body = JSON.parse(responseText(f)) as Record<string, unknown> & {
    disputed_transactions: Record<string, unknown>[];
  };
  body["dispute_id"] = ids.disputeId;
  const tx: Record<string, unknown> = {
    ...body.disputed_transactions[0],
    seller_transaction_id: ids.captureId,
  };
  if (custom === null) delete tx["custom"];
  else tx["custom"] = custom;
  body.disputed_transactions = [tx];
  server.use(
    http.get(
      `https://api-m.sandbox.paypal.com/v1/customer/disputes/${ids.disputeId}`,
      () => HttpResponse.json(body, { status: f.response.status }),
      { once: true },
    ),
  );
}

export function disputesClient(server: SetupServer): PayPalDisputesClient {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "test-client", clientSecret: "test-secret" },
    cache: new Map(),
  });
  const token = loadFixture("paypal/oauth/token");
  server.use(
    http.post(
      token.request.url,
      () => new HttpResponse(responseText(token), { status: 200, headers: token.response.headers }),
    ),
  );
  return createPayPalDisputesClient({ http: h, tokens, env: () => "sandbox" });
}
