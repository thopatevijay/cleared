// Live proof on the PayPal sandbox (M2-06 AC, resource PAYPAL_SANDBOX): the M0-05 dispute GET and one
// capture-linked lookup parse with the zod schemas. Read-only: two GETs plus one token. Skipped without
// PAYPAL_CLIENT_ID (CI, worktrees); run with the credentials inherited from a process that loaded `.env`.
import { describe, expect, it } from "vitest";
import { createHttpClient, VENDOR_TIMEOUTS_MS } from "../http/client.ts";
import { createPayPalDisputesClient } from "./disputes.ts";
import { DisputeListSchema, DisputeSchema } from "./disputes.schemas.ts";
import { PAYPAL_SANDBOX_BASE_URL } from "./orders.ts";
import { createTokenProvider } from "./token.ts";

/** The M0-05 full-path dispute and its capture (docs/evidence/m0-05-paypal-spike-b.md). */
const DISPUTE_ID = "PP-R-UVC-10195076";
const CAPTURE_ID = "794390931G848631R";

const clientId = process.env["PAYPAL_CLIENT_ID"] ?? "";
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"] ?? "";

describe.skipIf(clientId === "" || clientSecret === "")("disputes live (sandbox)", () => {
  const http = createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials: { clientId, clientSecret },
  });
  const dc = createPayPalDisputesClient({ http, tokens, env: () => "sandbox" });

  it("GET of the M0-05 dispute parses with DisputeSchema", async () => {
    const d = await dc.getDispute(DISPUTE_ID);
    expect(DisputeSchema.safeParse(d).success).toBe(true);
    expect(d.dispute_id).toBe(DISPUTE_ID);
    expect(d.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED");
    expect(d.disputed_transactions?.[0]?.seller_transaction_id).toBe(CAPTURE_ID);
    console.info(`live GET ${DISPUTE_ID}: ${d.status} / ${d.dispute_outcome?.outcome_code ?? "no outcome"}`);
  }, 30_000);

  it("the capture-linked lookup (disputed_transaction_id) parses with DisputeListSchema", async () => {
    const list = await dc.listDisputes({ disputedTransactionId: CAPTURE_ID });
    expect(DisputeListSchema.safeParse(list).success).toBe(true);
    expect(list.items.map((i) => i.dispute_id)).toContain(DISPUTE_ID);
    console.info(`live lookup ${CAPTURE_ID}: ${list.items.length.toString()} dispute(s)`);
  }, 30_000);
});
