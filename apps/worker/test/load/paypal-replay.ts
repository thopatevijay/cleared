// M4-06 local 100× burst only: preloaded with `node --import` through NODE_OPTIONS (scripts/load/local-env.sh),
// never imported by product code. Inside the WORKER process it answers the capture re-fetch of every burst
// capture (`LB` + 15 hex) with the recorded M1-04 sandbox GET capture
// (fixtures/paypal/orders/test-payment/get-capture.json), its ids and `custom_id` rewritten, and the recorded
// OAuth token. Every other PayPal or OpenAI request is refused, so a burst run makes no vendor call. In any
// other process (pnpm, next build, the web server) it does nothing.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { loadFixture, responseText } from "@cleared/adapters/testing/fixture";

const REC = { order: "662632381Y533430H", capture: "2FB27654CR016344S", ws: "41b50aa1-c3ef-42c0-9fa4-61e9a550f78d" };
const BURST_CAPTURE = /^LB([0-9A-F]{15})$/;
const isWorker = /apps\/worker\/src\/index\.ts$/.test(process.argv[1] ?? "");
const workspace = process.env["LOAD_REPLAY_WORKSPACE"] ?? "";

if (isWorker && process.env["LOAD_REPLAY"] === "1") {
  const refuse = ({ request }: { request: Request }) => {
    console.error(JSON.stringify({ service: "load-replay", msg: "refused", url: request.url }));
    return HttpResponse.error();
  };
  const server = setupServer(
    http.post("https://api-m.sandbox.paypal.com/v1/oauth2/token", () => {
      const f = loadFixture("paypal/oauth/token-m1-04");
      return new HttpResponse(responseText(f), { status: f.response.status, headers: f.response.headers });
    }),
    http.get("https://api-m.sandbox.paypal.com/v2/payments/captures/:id", ({ params }) => {
      const id = String(params["id"]);
      const m = BURST_CAPTURE.exec(id);
      if (m === null) return new HttpResponse(null, { status: 404 });
      const f = loadFixture("paypal/orders/test-payment/get-capture");
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const body = responseText(f)
        .replaceAll(REC.capture, id)
        .replaceAll(REC.order, `LO${m[1] ?? ""}`)
        .replaceAll(REC.ws, workspace)
        .replaceAll("2026-10-30T17:08:28Z", now);
      return new HttpResponse(body, { status: f.response.status, headers: f.response.headers });
    }),
    http.all("https://api-m.sandbox.paypal.com/*", refuse),
    http.all("https://api.sandbox.paypal.com/*", refuse),
    http.all("https://api.openai.com/*", refuse),
    http.all("https://api.resend.com/*", refuse),
  );
  server.listen({ onUnhandledFrame: "bypass" });
  console.log(JSON.stringify({ service: "load-replay", msg: "msw listening", workspace }));
}
