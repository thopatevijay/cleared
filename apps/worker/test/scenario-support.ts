// M2-10 worker tests: the PayPal sandbox for one or more judge scenarios, served by msw from the recorded
// exchanges only (M1-04 `orders/test-payment/*`, M0-05 `disputes/full/*` and `disputes/list/*`). Each run
// gets fresh order / capture / dispute ids (unique across the database) and its workspace as custom_id;
// the test moves each dispute and capture through PayPal's recorded states with `setPhase`. Every call is
// counted per run so the tests can prove "no second create / chargeback".
import { randomBytes } from "node:crypto";
import {
  createHttpClient,
  createPayPalCapturesClient,
  createPayPalDisputesClient,
  createPayPalOrdersClient,
  createTokenProvider,
} from "@cleared/adapters";
import { http, HttpResponse } from "msw";
import type { SetupServer } from "msw/node";
import { loadFixture, responseText } from "../../../packages/adapters/src/testing/fixture.ts";

const API = "https://api-m.sandbox.paypal.com";
const ORD = "paypal/orders/test-payment";
const FULL = "paypal/disputes/full";
const REC = {
  order: "662632381Y533430H",
  capture: "2FB27654CR016344S",
  ws: "41b50aa1-c3ef-42c0-9fa4-61e9a550f78d",
  dCapture: "794390931G848631R",
  dOrder: "734597746E180433H",
  dispute: "PP-R-UVC-10195076",
  dCustom: "spike-7f168094-2c09-4159-97c2-aa52549f3cb1",
};

/** PayPal's recorded states, in lifecycle order (M0-05). */
export const PHASES = {
  open: { dispute: `${FULL}/state-1-open`, capture: `${FULL}/capture-1-completed` },
  underReview: { dispute: `${FULL}/state-2-under_review`, capture: `${FULL}/capture-1-completed` },
  waiting: { dispute: `${FULL}/state-3-waiting_for_seller_response`, capture: `${FULL}/capture-2-pending` },
  adjudicable: { dispute: `${FULL}/state-4-under_review`, capture: `${FULL}/capture-2-pending` },
  decided: { dispute: `${FULL}/state-5-under_review`, capture: `${FULL}/capture-2-pending` },
  resolved: { dispute: `${FULL}/state-6-resolved`, capture: `${FULL}/capture-2-pending` },
  released: { dispute: `${FULL}/state-6-resolved`, capture: `${FULL}/capture-3-completed` },
} as const;
export type Phase = keyof typeof PHASES;

export interface SandboxRun {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly disputeId: string;
  phase: Phase;
  /** a chargeback POST landed (the list then returns the dispute) */
  disputed: boolean;
  readonly calls: Record<
    "create" | "confirm" | "capture" | "chargeback" | "list" | "adjudicate" | "getDispute" | "getCapture",
    number
  >;
  /** PayPal-Request-Ids seen on the order create, per call */
  readonly createRequestIds: string[];
}

const freshId = (len: number): string =>
  randomBytes(16)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, len);

function rewrite(text: string, r: SandboxRun): string {
  return text
    .replaceAll(REC.order, r.orderId)
    .replaceAll(REC.dOrder, r.orderId)
    .replaceAll(REC.capture, r.captureId)
    .replaceAll(REC.dCapture, r.captureId)
    .replaceAll(REC.dispute, r.disputeId)
    .replaceAll(REC.ws, r.workspaceId)
    .replaceAll(REC.dCustom, r.workspaceId);
}

function replay(name: string, r: SandboxRun): Response {
  const f = loadFixture(name);
  return new HttpResponse(rewrite(responseText(f), r), {
    status: f.response.status,
    headers: f.response.headers,
  });
}

export interface Sandbox {
  /** Registers a run for a workspace (its ids are fixed before the first call). */
  add(workspaceId: string): SandboxRun;
  byWorkspace(workspaceId: string): SandboxRun;
}

/** Installs the handlers on `server`; requests are routed to the run that owns the id in the URL/body. */
export function installSandbox(server: SetupServer): Sandbox {
  const runs: SandboxRun[] = [];
  const find = (pred: (r: SandboxRun) => boolean): SandboxRun => {
    const r = runs.find(pred);
    if (r === undefined) throw new Error("sandbox: no run for this request");
    return r;
  };
  const byOrder = (id: string | readonly string[] | undefined) => find((r) => r.orderId === id);
  const token = loadFixture("paypal/oauth/token");
  server.use(
    http.post(
      token.request.url,
      () => new HttpResponse(responseText(token), { status: 200, headers: token.response.headers }),
    ),
    http.post(`${API}/v2/checkout/orders`, async ({ request }) => {
      const body = (await request.json()) as { purchase_units: { custom_id: string }[] };
      const r = find((x) => x.workspaceId === body.purchase_units[0]?.custom_id);
      r.calls.create += 1;
      r.createRequestIds.push(request.headers.get("paypal-request-id") ?? "");
      return replay(`${ORD}/create`, r);
    }),
    http.post(`${API}/v2/checkout/orders/:id/confirm-payment-source`, ({ params }) => {
      const r = byOrder(params["id"]);
      r.calls.confirm += 1;
      return replay(`${ORD}/confirm`, r);
    }),
    http.post(`${API}/v2/checkout/orders/:id/capture`, ({ params }) => {
      const r = byOrder(params["id"]);
      r.calls.capture += 1;
      return replay(`${ORD}/capture`, r);
    }),
    http.get(`${API}/v2/payments/captures/:id`, ({ params }) => {
      const r = find((x) => x.captureId === params["id"]);
      r.calls.getCapture += 1;
      return replay(PHASES[r.phase].capture, r);
    }),
    http.get(`${API}/v1/customer/disputes`, ({ request }) => {
      const capture = new URL(request.url).searchParams.get("disputed_transaction_id");
      const r = find((x) => x.captureId === capture);
      r.calls.list += 1;
      // the recorded list body, narrowed to this capture's dispute (none before the chargeback)
      const recorded = JSON.parse(
        rewrite(responseText(loadFixture("paypal/disputes/list/update-time-after")), r),
      ) as {
        items: { dispute_id: string }[];
      };
      const items = r.disputed ? recorded.items.filter((i) => i.dispute_id === r.disputeId) : [];
      return HttpResponse.json({ ...recorded, items });
    }),
    http.post(`${API}/v2/customer-support/process-chargeback`, async ({ request }) => {
      const body = (await request.json()) as { transaction: { id_enc: string } };
      const r = find((x) => x.captureId === body.transaction.id_enc);
      r.calls.chargeback += 1;
      r.disputed = true;
      return replay(`${FULL}/chargeback`, r);
    }),
    http.get(`${API}/v1/customer/disputes/:id`, ({ params }) => {
      const r = find((x) => x.disputeId === params["id"]);
      r.calls.getDispute += 1;
      return replay(PHASES[r.phase].dispute, r);
    }),
    http.post(`${API}/v1/customer/disputes/:id/adjudicate`, ({ params }) => {
      const r = find((x) => x.disputeId === params["id"]);
      r.calls.adjudicate += 1;
      r.phase = "decided";
      return replay(`${FULL}/write-adjudicate.2`, r);
    }),
  );
  return {
    add(workspaceId) {
      const hex = freshId(8);
      const run: SandboxRun = {
        workspaceId,
        orderId: `${freshId(9)}T${freshId(7)}`,
        captureId: `${freshId(9)}S${freshId(7)}`,
        disputeId: `PP-R-TST-${hex}`,
        phase: "open",
        disputed: false,
        calls: {
          create: 0,
          confirm: 0,
          capture: 0,
          chargeback: 0,
          list: 0,
          adjudicate: 0,
          getDispute: 0,
          getCapture: 0,
        },
        createRequestIds: [],
      };
      runs.push(run);
      return run;
    },
    byWorkspace: (ws) => find((r) => r.workspaceId === ws),
  };
}

/** The product PayPal clients on a fast, non-retrying HTTP client (msw answers every call). */
export function sandboxClients() {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 5_000, maxRetries: 0, log: false });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: API,
    credentials: { clientId: "test-client", clientSecret: "test-secret" },
    cache: new Map(),
  });
  return {
    orders: createPayPalOrdersClient({ http: h, tokens }),
    captures: createPayPalCapturesClient({ http: h, tokens }),
    disputes: createPayPalDisputesClient({ http: h, tokens, env: () => "sandbox" }),
  };
}
