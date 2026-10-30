// Webhook test support (M1-04): the M0-06 delivery fixtures, an msw server that serves only what a test
// allows (and records every outbound request), and route deps on the compose Postgres with a send-only
// pg-boss producer.
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  createHttpClient,
  createLogger,
  createPayPalWebhooksClient,
  createTokenProvider,
  createWebhookAuthenticator,
  createWebhookVerifier,
  headerValue,
  signedString,
  type PayPalEnv,
  type WebhookVerifier,
} from "@cleared/adapters";
import { createPublisher, createQueue, type Queue } from "@cleared/db";
import { http as mswHttp, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import type { PayPalWebhookDeps } from "../../src/server/handlers/paypal-webhook.ts";
import { testDb } from "../support/db.ts";
import { FIXTURES_DIR, loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";

export const DeliverySchema = z.object({
  meta: z.object({ scrubbed: z.boolean(), signed_webhook_id: z.string().optional() }).loose(),
  event_type: z.string(),
  headers: z.record(z.string(), z.string()),
  raw_body: z.string(),
  cert_pem: z.string().optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export function loadDeliveries(area: "simulator" | "deliveries"): [string, Delivery][] {
  const dir = `${FIXTURES_DIR}paypal/webhooks/${area}/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f, DeliverySchema.parse(JSON.parse(readFileSync(dir + f, "utf8")))]);
}

export const eventIdOf = (d: Delivery): string => (JSON.parse(d.raw_body) as { id: string }).id;
export const sentAt = (d: Delivery): number => Date.parse(headerValue(d.headers, "paypal-transmission-time") ?? "");
export const certUrlOf = (d: Delivery): string => headerValue(d.headers, "paypal-cert-url") ?? "";

/** One byte changed in the middle of the body (stays valid UTF-8). */
export function flipByte(raw: string): string {
  const i = Math.floor(raw.length / 2);
  const c = raw.charCodeAt(i);
  return raw.slice(0, i) + String.fromCharCode(c === 0x41 ? 0x42 : 0x41) + raw.slice(i + 1);
}

/** A runtime key pair (never stored) to re-sign scrubbed real deliveries, as M0-06's replay test does. */
export const RESIGN_WEBHOOK_ID = "WH-M1-04-RESIGNED";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export function resign(d: Delivery, webhookId = RESIGN_WEBHOOK_ID): Record<string, string> {
  const message = signedString({
    transmissionId: headerValue(d.headers, "paypal-transmission-id") ?? "",
    transmissionTime: headerValue(d.headers, "paypal-transmission-time") ?? "",
    webhookId,
    rawBody: d.raw_body,
  });
  return { ...d.headers, "paypal-transmission-sig": sign("sha256", Buffer.from(message), keys.privateKey).toString("base64") };
}
export function seedResignKey(verifier: WebhookVerifier, d: Delivery, now: number): void {
  verifier.cache.set(certUrlOf(d), {
    publicKey: keys.publicKey,
    validFrom: new Date(now - 86_400_000),
    validTo: new Date(now + 86_400_000),
  });
}

/** msw: every request is recorded; only handlers a test adds answer, the rest fail as network errors. */
export const outbound: string[] = [];
export const server = setupServer(
  mswHttp.all("*", () => HttpResponse.error()),
);
server.events.on("request:start", ({ request }) => {
  outbound.push(`${request.method} ${request.url}`);
});

/** Serves a recorded fixture once for its method + URL (the M0-06 management recordings). */
export function serveFixture(name: string, transform?: (body: unknown) => unknown): void {
  const f = loadFixture(name);
  const method = f.request.method.toLowerCase() as "get" | "post";
  server.use(
    mswHttp[method](
      f.request.url,
      () => {
        const body = transform ? JSON.stringify(transform(f.response.body)) : responseText(f);
        return new HttpResponse(body, { status: f.response.status, headers: f.response.headers });
      },
      { once: true },
    ),
  );
}

export function serveCert(d: Delivery): void {
  const pem = d.cert_pem ?? "";
  server.use(mswHttp.get(certUrlOf(d), () => new HttpResponse(pem, { status: 200 })));
}

let producer: Promise<Queue> | undefined;
export function testProducer(): Promise<Queue> {
  producer ??= createQueue(testDb(), { background: false, max: 2 });
  return producer;
}

export interface RouteDepsOptions {
  readonly webhookId: string;
  readonly now: number;
  readonly env?: PayPalEnv;
  readonly certTimeoutMs?: number;
}

/** Route deps with an injected clock; every HTTP call goes through msw (global fetch). */
export async function routeDeps(o: RouteDepsOptions): Promise<PayPalWebhookDeps & { verifier: WebhookVerifier }> {
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0 });
  const verifier = createWebhookVerifier({
    http,
    now: () => o.now,
    ...(o.certTimeoutMs === undefined ? {} : { certTimeoutMs: o.certTimeoutMs }),
  });
  const wh = createPayPalWebhooksClient({
    http,
    tokens: createTokenProvider({
      http,
      baseUrl: "https://api-m.sandbox.paypal.com",
      credentials: { clientId: "test-client", clientSecret: "test-secret" },
      cache: new Map(),
    }),
  });
  const db = testDb();
  return {
    db,
    verifier,
    publisher: createPublisher(db, await testProducer()),
    authenticate: createWebhookAuthenticator({
      verifier,
      verifyViaApi: (i) => wh.verifyViaApi(i),
      webhookId: o.webhookId,
      env: o.env ?? "sandbox",
    }),
    log: createLogger({ service: "web-test", level: "silent" }),
    now: () => new Date(o.now),
  };
}

export function post(raw: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/webhooks/paypal", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

/** Rows and capture-sync jobs for these PayPal event ids. */
export async function counts(eventIds: readonly string[]): Promise<{ rows: number; jobs: number }> {
  const c = testDb().$client;
  const rows = await c.query<{ n: string }>(
    "select count(*) as n from webhook_events where provider = 'paypal' and event_id = any($1)",
    [eventIds],
  );
  const jobs = await c.query<{ n: string }>(
    `select count(*) as n from pgboss.job where name = 'paypal.capture.sync'
       and data->'data'->>'eventId' in (select id::text from webhook_events where event_id = any($1))`,
    [eventIds],
  );
  return { rows: Number(rows.rows[0]?.n ?? 0), jobs: Number(jobs.rows[0]?.n ?? 0) };
}

/** Removes what a test stored for these event ids (fixture event ids are fixed across runs). */
export async function cleanup(eventIds: readonly string[]): Promise<void> {
  const c = testDb().$client;
  await c.query(
    `delete from pgboss.job where name = 'paypal.capture.sync'
       and data->'data'->>'eventId' in (select id::text from webhook_events where event_id = any($1))`,
    [eventIds],
  );
  await c.query("delete from webhook_events where provider = 'paypal' and event_id = any($1)", [eventIds]);
}
