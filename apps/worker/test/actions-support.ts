// Shared by the M2-08 worker tests: a workspace that owns a dispute (mirror row, compiled-PDF draft), an
// approved action on it (through the real approve path), msw serving the recorded M0-05 dispute GETs and
// write responses, and a record of every PayPal request (method, path, PayPal-Request-Id).
import { createHash, randomUUID } from "node:crypto";
import {
  createLogger,
  createHttpClient,
  createPayPalDisputesClient,
  createTokenProvider,
} from "@cleared/adapters";
import { canonicalHash, WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import {
  appendActionAudit,
  approveProposedAction,
  forWorkspace,
  platform,
  withTransaction,
  type Db,
  type JobWithMetadata,
  type Publisher,
} from "@cleared/db";
import { delay, http, HttpResponse } from "msw";
import type { SetupServer } from "msw/node";
import { loadFixture, responseText } from "../../../packages/adapters/src/testing/fixture.ts";
import type { ConsumeContext } from "../src/consume.ts";
import { freshIds, serveDispute, type Ids } from "./disputes-support.ts";

export const BASE = "https://api-m.sandbox.paypal.com";
/** Before the recorded due date (2026-11-09T04:59:59Z) by far. */
export const NOW = new Date("2026-11-01T00:00:00.000Z");
/** Synthetic compiled PDF (M2-07 compiles the real one). */
export const PDF = new TextEncoder().encode("%PDF-1.4\n% Cleared synthetic evidence pack\n%%EOF\n");
export const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

export interface PayPalCall {
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;
}

/** Records every request msw sees for the PayPal host (the OAuth token call excluded). */
export function recordCalls(server: SetupServer): PayPalCall[] {
  const calls: PayPalCall[] = [];
  server.events.on("request:start", ({ request }) => {
    const u = new URL(request.url);
    if (u.origin !== BASE || u.pathname.startsWith("/v1/oauth2")) return;
    calls.push({
      method: request.method,
      path: u.pathname,
      requestId: request.headers.get("paypal-request-id"),
    });
  });
  return calls;
}

export const writes = (calls: readonly PayPalCall[]): PayPalCall[] => calls.filter((c) => c.method !== "GET");

/** The disputes client over msw (no retries; short timeouts) and its HTTP client (for the breaker). */
export function disputesWithHttp(server: SetupServer) {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: BASE,
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
  return { http: h, disputes: createPayPalDisputesClient({ http: h, tokens, env: () => "sandbox" }) };
}

/** Serves a recorded write response (`fixture`) for `path` once; `waitMs` delays it (timeout tests). */
export function serveWrite(server: SetupServer, ids: Ids, op: string, fixture: string, waitMs = 0): void {
  const f = loadFixture(fixture);
  server.use(
    http.post(
      `${BASE}/v1/customer/disputes/${ids.disputeId}/${op}`,
      async () => {
        if (waitMs > 0) await delay(waitMs);
        return new HttpResponse(responseText(f), { status: f.response.status, headers: f.response.headers });
      },
      { once: true },
    ),
  );
}

export interface Scene {
  readonly ws: string;
  readonly ids: Ids;
  readonly actionId: string;
  readonly payload: JsonValue;
}

/** A workspace owning a fresh dispute (mirror row WAITING_FOR_SELLER_RESPONSE) with a compiled-PDF draft. */
export async function sceneWithDispute(
  db: Db,
  created: string[],
): Promise<Omit<Scene, "actionId" | "payload"> & { draftId: string }> {
  const w = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  created.push(w.id);
  const ids = freshIds();
  const owners = platform(db).resourceOwners;
  await owners.claim({ resourceType: "capture", resourceId: ids.captureId, workspaceId: w.id });
  await owners.claim({ resourceType: "dispute", resourceId: ids.disputeId, workspaceId: w.id });
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(w.id));
  const dispute = await repos.disputes.insert({
    disputeId: ids.disputeId,
    status: "WAITING_FOR_SELLER_RESPONSE",
    allowedActions: ["accept_claim", "provide_evidence"],
    sellerResponseDueDate: new Date("2026-11-09T04:59:59.000Z"),
    paypalUpdatedAt: new Date("2026-10-29T05:00:00.000Z"),
  });
  const blob = await repos.blobs.insert({
    mime: "application/pdf",
    bytes: Buffer.from(PDF),
    size: PDF.byteLength,
    sha256: PDF_SHA,
  });
  const draft = await repos.disputeDrafts.insert({
    disputeId: dispute.id,
    notes: "n",
    compiledBlobId: blob.id,
    sha256: PDF_SHA,
  });
  return { ws: w.id, ids, draftId: draft.id };
}

export function evidencePayload(ids: Ids, draftId: string): JsonValue {
  return {
    dispute_id: ids.disputeId,
    evidence_type: "PROOF_OF_FULFILLMENT",
    notes:
      "Evidence. Synthetic sandbox case: the item was dispatched with tracking and delivered; the delivery note is attached.",
    compiled_blob_sha256: PDF_SHA,
    draft_id: draftId,
  };
}

/** Inserts a proposal (with its `action.proposed` audit row) the way the agent's tool does, then approves it. */
export async function approvedAction(
  db: Db,
  publisher: Publisher,
  scene: { ws: string; ids: Ids },
  kind: string,
  payload: JsonValue,
): Promise<string> {
  const id = await propose(db, scene.ws, kind, payload);
  const sha = canonicalHash(payload);
  const r = await approveProposedAction(db, publisher, {
    workspaceId: scene.ws,
    actionId: id,
    actor: "seller-test",
    now: NOW,
    payloadSha256: sha,
  });
  if (!r.ok) throw new Error(`approve refused: ${r.code}`);
  return id;
}

export async function propose(db: Db, ws: string, kind: string, payload: JsonValue): Promise<string> {
  const sha = canonicalHash(payload);
  return withTransaction(db, async (tx) => {
    const row = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).proposedActions.insert(
      { kind: kind as never, payload, payloadSha256: sha, state: "proposed", risk: "high" },
      tx,
    );
    await appendActionAudit(
      db,
      { workspaceId: ws, actionId: row.id, actor: "agent", action: "action.proposed", detail: { kind } },
      tx,
    );
    return row.id;
  });
}

/** A consumer context for calling a job function directly, inside `tx`. */
export function ctxFor(tx: ConsumeContext["tx"], data: unknown): ConsumeContext {
  const job = { id: randomUUID(), retryCount: 0, createdOn: NOW } as JobWithMetadata<unknown>;
  return {
    tx,
    log: createLogger({ service: "worker-test", level: (process.env["TEST_LOG"] ?? "silent") }),
    job,
    envelope: { messageId: randomUUID(), correlationId: randomUUID(), data },
  };
}

export { serveDispute };
