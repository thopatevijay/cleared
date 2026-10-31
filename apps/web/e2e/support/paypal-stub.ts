// Local E2E only (M1-07 AC 1): PayPal for the local web and worker processes is msw replaying the
// recorded M1-04 sandbox exchanges, preloaded with `node --import` (never imported by product code).
//
//   E2E_PAYPAL_STUB=worker  orders create → confirm-payment-source → capture, and GET capture, from
//                           fixtures/paypal/orders/test-payment/* with fresh order/capture ids and the
//                           requesting workspace as custom_id. After the capture it posts the recorded
//                           PAYMENT.CAPTURE.COMPLETED delivery (same rewrite, fresh event id and
//                           transmission time) to E2E_WEB_URL/api/webhooks/paypal, as PayPal would.
//   E2E_PAYPAL_STUB=web     the webhook route's verification: the cert fetch fails (inconclusive), so the
//                           route falls back to the verify-signature postback, answered by the recorded
//                           M0-06 response (SUCCESS). Everything else is refused (network error).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";
import {
  FIXTURES_DIR,
  loadFixture,
  responseText,
} from "../../../../packages/adapters/src/testing/fixture.ts";
import { openAiHandlers } from "./openai-stub.ts";

const API = "https://api-m.sandbox.paypal.com";
const REC = {
  order: "662632381Y533430H",
  capture: "2FB27654CR016344S",
  ws: "41b50aa1-c3ef-42c0-9fa4-61e9a550f78d",
};
const role = process.env["E2E_PAYPAL_STUB"];
const webUrl = process.env["E2E_WEB_URL"] ?? "http://localhost:3100";
const DELIVERY_DELAY_MS = Number(process.env["E2E_WEBHOOK_DELAY_MS"] ?? "1500");

const paypalId = (): string =>
  randomBytes(12)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .padEnd(17, "0")
    .slice(0, 17);

interface Order {
  readonly orderId: string;
  readonly captureId: string;
  readonly ws: string;
}
const orders = new Map<string, Order>();
const captures = new Map<string, Order>();

/** The recorded response with the recorded ids swapped for this run's. */
function replay(name: string, o: Order, extra: (body: string) => string = (b) => b): Response {
  const f = loadFixture(name);
  const body = extra(
    responseText(f)
      .replaceAll(REC.order, o.orderId)
      .replaceAll(REC.capture, o.captureId)
      .replaceAll(REC.ws, o.ws),
  );
  return new HttpResponse(body, { status: f.response.status, headers: f.response.headers });
}

const token = () => {
  const f = loadFixture("paypal/oauth/token-m1-04");
  return new HttpResponse(responseText(f), { status: f.response.status, headers: f.response.headers });
};

function deliver(o: Order): void {
  const d = JSON.parse(
    readFileSync(`${FIXTURES_DIR}paypal/webhooks/deliveries/payment-capture-completed.json`, "utf8"),
  ) as { headers: Record<string, string>; raw_body: string };
  const event = JSON.parse(d.raw_body) as {
    id: string;
    create_time: string;
    resource: Record<string, unknown> & { supplementary_data: { related_ids: Record<string, string> } };
  };
  const now = new Date().toISOString();
  event.id = `WH-E2E-${randomUUID()}`;
  event.create_time = now;
  event.resource["id"] = o.captureId;
  event.resource["custom_id"] = o.ws;
  event.resource.supplementary_data.related_ids["order_id"] = o.orderId;
  const headers = {
    ...d.headers,
    "paypal-transmission-id": randomUUID(),
    "paypal-transmission-time": now.replace(/\.\d{3}Z$/, "Z"),
  };
  setTimeout(() => {
    void fetch(`${webUrl}/api/webhooks/paypal`, { method: "POST", headers, body: JSON.stringify(event) })
      .then((r) => {
        console.log(
          JSON.stringify({ service: "e2e-paypal-stub", msg: "webhook delivered", status: r.status }),
        );
      })
      .catch((e: unknown) => {
        console.error(
          JSON.stringify({ service: "e2e-paypal-stub", msg: "webhook delivery failed", error: String(e) }),
        );
      });
  }, DELIVERY_DELAY_MS);
}

// M2-09: the seeded E2E disputes (`PP-D-E2E-…`, test/support/dispute-seed.ts) replay the recorded M0-05
// lifecycle (fixtures/paypal/disputes/full): WAITING_FOR_SELLER_RESPONSE (evidence + accept_claim links)
// until the evidence write, which answers with the recorded 200 (paypal-debug-id ca51fc56edb2d); after it,
// GETs return the recorded RESOLVED state (RESOLVED_WITH_PAYOUT / REPRESENTED_BY_PAYPAL) and the capture
// reads COMPLETED. COMPRESSED on purpose: the sandbox's own review step (adjudicate, M2-10's live spec)
// is skipped here. Ids, the dispute amount ($120.00 USD) and times are rewritten; `custom` is dropped, so
// ownership comes from the seeded owner rows.
const E2E_DISPUTE = /^PP-D-E2E-[0-9A-F]{10}$/;
const FULL = "paypal/disputes/full";
const filed = new Set<string>();
const e2eCapture = (disputeId: string): string => `E2E${disputeId.slice(-10)}CAP0`;
const nowIso = (): string => new Date().toISOString();

function disputeBody(id: string): Response {
  const resolved = filed.has(id);
  const f = loadFixture(`${FULL}/${resolved ? "state-6-resolved" : "state-3-waiting_for_seller_response"}`);
  const rec = JSON.parse(responseText(f)) as Record<string, unknown> & {
    dispute_id: string;
    disputed_transactions: Record<string, unknown>[];
  };
  const body = JSON.parse(responseText(f).replaceAll(rec.dispute_id, id)) as typeof rec;
  body.disputed_transactions = body.disputed_transactions.map((t) => {
    const rest = { ...t };
    delete rest["custom"];
    return {
      ...rest,
      seller_transaction_id: e2eCapture(id),
      gross_amount: { currency_code: "USD", value: "120.00" },
    };
  });
  body["dispute_amount"] = { currency_code: "USD", value: "120.00" };
  body["update_time"] = nowIso();
  if (!resolved) body["seller_response_due_date"] = new Date(Date.now() + 5 * 86_400_000).toISOString();
  return HttpResponse.json(body, {
    status: 200,
    headers: { "paypal-debug-id": `e2e${id.slice(-6).toLowerCase()}` },
  });
}

function captureBody(id: string, disputeId: string): Response {
  const f = loadFixture(`${FULL}/${filed.has(disputeId) ? "capture-3-completed" : "capture-2-pending"}`);
  const rec = JSON.parse(responseText(f)) as { id: string };
  const body = JSON.parse(responseText(f).replaceAll(rec.id, id)) as Record<string, unknown>;
  delete body["custom_id"];
  body["amount"] = { currency_code: "USD", value: "120.00" };
  body["update_time"] = nowIso().replace(/\.\d{3}Z$/, "Z");
  return HttpResponse.json(body, { status: 200 });
}

const disputeHandlers = [
  http.get(`${API}/v1/customer/disputes/:id`, ({ params }) => {
    const id = String(params["id"]);
    return E2E_DISPUTE.test(id) ? disputeBody(id) : HttpResponse.error();
  }),
  http.post(`${API}/v1/customer/disputes/:id/provide-evidence`, ({ params }) => {
    const id = String(params["id"]);
    if (!E2E_DISPUTE.test(id)) return HttpResponse.error();
    filed.add(id);
    const f = loadFixture(`${FULL}/write-evidence.2`);
    return new HttpResponse(responseText(f).replaceAll("PP-R-UVC-10195076", id), {
      status: f.response.status,
      headers: f.response.headers,
    });
  }),
];

const workerHandlers = [
  http.post(`${API}/v1/oauth2/token`, token),
  ...disputeHandlers,
  http.post(`${API}/v2/checkout/orders`, async ({ request }) => {
    const body = (await request.json()) as { purchase_units: { custom_id: string }[] };
    const o = { orderId: paypalId(), captureId: paypalId(), ws: body.purchase_units[0]?.custom_id ?? "" };
    orders.set(o.orderId, o);
    return replay("paypal/orders/test-payment/create", o);
  }),
  http.post(`${API}/v2/checkout/orders/:id/confirm-payment-source`, ({ params }) => {
    const o = orders.get(String(params["id"]));
    return o ? replay("paypal/orders/test-payment/confirm", o) : new HttpResponse(null, { status: 404 });
  }),
  http.post(`${API}/v2/checkout/orders/:id/capture`, ({ params }) => {
    const o = orders.get(String(params["id"]));
    if (!o) return new HttpResponse(null, { status: 404 });
    captures.set(o.captureId, o);
    deliver(o);
    return replay("paypal/orders/test-payment/capture", o);
  }),
  http.get(`${API}/v2/payments/captures/:id`, ({ params }) => {
    const e2e = /^E2E([0-9A-F]{10})CAP0$/.exec(String(params["id"]));
    if (e2e !== null) return captureBody(String(params["id"]), `PP-D-E2E-${e2e[1] ?? ""}`);
    const o = captures.get(String(params["id"]));
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    return o
      ? replay("paypal/orders/test-payment/get-capture", o, (b) => b.replaceAll("2026-10-30T17:08:28Z", now))
      : new HttpResponse(null, { status: 404 });
  }),
  http.all(`${webUrl}/*`, () => passthrough()),
];

const webHandlers = [
  http.get("https://api.sandbox.paypal.com/v1/notifications/certs/*", () => HttpResponse.error()),
  http.post(`${API}/v1/oauth2/token`, token),
  http.post(`${API}/v1/notifications/verify-webhook-signature`, () => {
    const f = loadFixture("paypal/webhooks/management/verify-signature");
    return new HttpResponse(responseText(f), { status: f.response.status, headers: f.response.headers });
  }),
];

if (role === "worker" || role === "web") {
  const server = setupServer(
    // M2-05: the worker's AI calls replay the recorded OpenAI responses (openai-stub.ts)
    ...(role === "worker" ? [...workerHandlers, ...openAiHandlers] : webHandlers),
    // Nothing else leaves the process: no real PayPal, no passthrough.
    http.all("*", ({ request }) => {
      console.error(JSON.stringify({ service: "e2e-paypal-stub", msg: "refused", url: request.url }));
      return HttpResponse.error();
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
  console.log(JSON.stringify({ service: "e2e-paypal-stub", msg: "msw listening", role }));
}
