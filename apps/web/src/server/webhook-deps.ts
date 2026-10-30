// What the PayPal webhook route needs (M1-04), built lazily on the first delivery (never at build time):
// the shared pool, a send-only pg-boss producer, one webhook verifier per process (its cert cache), and
// the API fallback. PAYPAL_WEBHOOK_ID unset → the route answers 503 (fail closed), never verifies with
// a guessed id.
import {
  correlationIdOrNew,
  createHttpClient,
  createPayPalWebhooksClient,
  createTokenProvider,
  createWebhookAuthenticator,
  createWebhookVerifier,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
} from "@cleared/adapters";
import { createPublisher, createQueue } from "@cleared/db";
import { z } from "zod";
import { getDb } from "./deps.ts";
import { webLogger } from "./request-context.ts";
import type { PayPalWebhookDeps } from "./handlers/paypal-webhook.ts";

const Env = z.object({
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
});

/** Cert fetches get a short budget so an inconclusive self-verify falls back well inside the ack time. */
export const CERT_TIMEOUT_MS = 3_000;

let pending: Promise<PayPalWebhookDeps> | undefined;

async function build(): Promise<PayPalWebhookDeps> {
  const env = Env.parse(process.env);
  if (env.PAYPAL_ENV === "live") throw new Error("live PayPal is not enabled (sandbox only)");
  const db = getDb();
  const boss = await createQueue(db, { background: false, max: 2 });
  const http = createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  const webhookId = env.PAYPAL_WEBHOOK_ID ?? "";
  const creds =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET }
      : null;
  const wh =
    creds === null
      ? null
      : createPayPalWebhooksClient({
          http,
          tokens: createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials: creds }),
        });
  return {
    db,
    publisher: createPublisher(db, boss, correlationIdOrNew),
    authenticate:
      webhookId === ""
        ? null
        : createWebhookAuthenticator({
            verifier: createWebhookVerifier({ http, certTimeoutMs: CERT_TIMEOUT_MS }),
            verifyViaApi: (i) =>
              wh === null ? Promise.reject(new Error("no PayPal credentials")) : wh.verifyViaApi(i),
            webhookId,
            env: env.PAYPAL_ENV,
          }),
    log: webLogger(),
    now: () => new Date(),
  };
}

export function getWebhookDeps(): Promise<PayPalWebhookDeps> {
  pending ??= build().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
