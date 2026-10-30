// POST /api/webhooks/paypal (M1-04): a thin wrapper; the handler and its tests live in src/server.
import { postPayPalWebhook } from "../../../../src/server/handlers/paypal-webhook.ts";
import { getWebhookDeps } from "../../../../src/server/webhook-deps.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// The raw body, crypto and pg need Node; read the environment per request, never at build time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/webhooks/paypal",
  async (req: Request) => postPayPalWebhook(req, await getWebhookDeps()),
  { webhookAck: true },
);
