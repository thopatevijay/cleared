// M2-08: the action governance API. Session-scoped reads, approve bound to the payload hash (with its
// approvals row, outbox event and execution job in one transaction), reject, the seller-only accept_claim
// proposal with its typed confirmation, CSRF + Idempotency-Key, and the App Router route modules themselves.
import { randomUUID } from "node:crypto";
import { canonicalHash, WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import {
  actionAuditTrail,
  createPublisher,
  createQueue,
  forWorkspace,
  getProposedAction,
  type Publisher,
} from "@cleared/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import {
  getAction,
  postAcceptClaimProposal,
  postApprove,
  postReject,
} from "../../../src/server/handlers/actions.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, ORIGIN, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";

let pub: Promise<Publisher> | undefined;
const created: string[] = [];
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

const repos = (ws: string) => forWorkspace(testDb(), WorkspaceIdSchema.parse(ws));

const evidence = (): JsonValue => ({
  dispute_id: `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`,
  evidence_type: "PROOF_OF_FULFILLMENT",
  notes: "Delivered on 4 Oct; the signed delivery note is attached.",
  compiled_blob_sha256: "1cfdd3fb2b074dcf23e3160af91a88fdda2a2d812693cf07d5d2ea527efdc52f",
  draft_id: randomUUID(),
});

async function proposal(
  ws: string,
  kind = "provide_evidence",
  payload: JsonValue = evidence(),
  runId: string | null = null,
) {
  const row = await repos(ws).proposedActions.insert({
    kind: kind as never,
    payload,
    payloadSha256: canonicalHash(payload),
    state: "proposed",
    risk: "high",
    createdByRunId: runId,
  });
  return row;
}

async function agentRun(ws: string): Promise<string> {
  const r = await repos(ws).agentRuns.insert({
    task: "draft_dispute",
    inputHash: "c".repeat(64),
    model: "test",
    status: "succeeded",
  });
  return r.id;
}

async function dispute(ws: string, allowed: string[] = ["accept_claim", "provide_evidence"]) {
  return repos(ws).disputes.insert({
    disputeId: `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    status: "WAITING_FOR_SELLER_RESPONSE",
    allowedActions: allowed,
    amount: "64.00",
    currency: "USD",
  });
}

type Body = { action?: Record<string, unknown>; error?: { code: string; details: unknown } };
const read = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Body,
  replay: res.headers.get("idempotent-replay"),
});

const approve = async (cookie: string, id: string, body: unknown, key?: string) =>
  read(
    await postApprove(
      req(`/api/actions/${id}/approve`, { cookie, body, ...(key === undefined ? {} : { key }) }),
      testDeps(),
      publisher,
      id,
    ),
  );

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await testDb().$client.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!dbAvailable)("action governance API (integration)", () => {
  afterAll(async () => {
    const db = testDb();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("GET /api/actions/:id: payload, payload_sha256, state; another workspace's action is 404; no session 401", async () => {
    const a = await demo();
    const b = await demo();
    const row = await proposal(a.ws);
    const get = async (cookie: string, id: string) =>
      read(await getAction(req(`/api/actions/${id}`, { method: "GET", cookie }), testDeps(), id));
    const own = await get(a.cookie, row.id);
    expect(own.status).toBe(200);
    expect(own.body.action).toMatchObject({
      id: row.id,
      kind: "provide_evidence",
      state: "proposed",
      createdBy: "seller",
      payload_sha256: row.payloadSha256,
      refusal: null,
      approval: null,
      execution: null,
    });
    expect(canonicalHash(own.body.action?.["payload"] as JsonValue)).toBe(row.payloadSha256);
    expect((await get(b.cookie, row.id)).status).toBe(404);
    expect((await get(a.cookie, "not-a-uuid")).status).toBe(404);
    expect((await get("__Host-cleared_session=" + "a".repeat(43), row.id)).status).toBe(401);
  });

  it("approve with a stale hash → 409 APPROVAL_HASH_MISMATCH, nothing approved, the refusal audited", async () => {
    const a = await demo();
    const row = await proposal(a.ws);
    const stale = canonicalHash({ ...(row.payload as Record<string, JsonValue>), notes: "an older draft" });
    const r = await approve(a.cookie, row.id, { payload_sha256: stale });
    expect(r).toMatchObject({
      status: 409,
      body: { error: { code: "approval_hash_mismatch", details: { refusal: "APPROVAL_HASH_MISMATCH" } } },
    });
    expect((await getProposedAction(testDb(), a.ws, row.id))?.state).toBe("proposed");
    expect(await count("select count(*) as n from approvals where action_id = $1", [row.id])).toBe(0);
    expect(
      await count(
        "select count(*) as n from pgboss.job where name = 'action.execute' and data->'data'->>'actionId' = $1",
        [row.id],
      ),
    ).toBe(0);
    const trail = await actionAuditTrail(testDb(), a.ws, row.id);
    expect(trail.at(-1)).toMatchObject({
      actor: "seller",
      action: "action.approval_refused",
      detail: { code: "APPROVAL_HASH_MISMATCH" },
    });
  });

  it("approve with the exact hash → approved: approvals row (bound hash), action.approved outbox row and one action.execute job; key replay; second decision 409", async () => {
    const a = await demo();
    const row = await proposal(a.ws);
    const key = randomUUID();
    const r = await approve(a.cookie, row.id, { payload_sha256: row.payloadSha256 }, key);
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({
      state: "approved",
      approval: { approvedAt: expect.any(String) as string },
    });
    const ap = await testDb().$client.query(
      "select payload_sha256, approved_by from approvals where action_id = $1",
      [row.id],
    );
    expect(ap.rows).toHaveLength(1);
    expect(ap.rows[0]).toMatchObject({ payload_sha256: row.payloadSha256 });
    expect(
      await count(
        "select count(*) as n from outbox where topic = 'action.approved' and payload->'data'->>'actionId' = $1",
        [row.id],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*) as n from pgboss.job where name = 'action.execute' and data->'data'->>'actionId' = $1",
        [row.id],
      ),
    ).toBe(1);

    const again = await approve(a.cookie, row.id, { payload_sha256: row.payloadSha256 }, key);
    expect(again).toMatchObject({ status: 200, replay: "true" });
    expect(await count("select count(*) as n from approvals where action_id = $1", [row.id])).toBe(1);
    const fresh = await approve(a.cookie, row.id, { payload_sha256: row.payloadSha256 });
    expect(fresh).toMatchObject({
      status: 409,
      body: { error: { code: "action_not_proposed", details: { refusal: "ACTION_NOT_PROPOSED" } } },
    });
  });

  it("CSRF and validation: no Idempotency-Key → 400, foreign Origin → 403, bad body → 400, invalid payload → 422", async () => {
    const a = await demo();
    const row = await proposal(a.ws);
    const post = (init: Parameters<typeof req>[1]) =>
      postApprove(
        req(`/api/actions/${row.id}/approve`, { cookie: a.cookie, ...init }),
        testDeps(),
        publisher,
        row.id,
      );
    expect((await post({ key: null, body: { payload_sha256: row.payloadSha256 } })).status).toBe(400);
    expect(
      (await post({ origin: "https://evil.example", body: { payload_sha256: row.payloadSha256 } })).status,
    ).toBe(403);
    expect((await post({ body: { payload_sha256: "nope" } })).status).toBe(400);
    expect((await post({ body: { payload_sha256: row.payloadSha256, extra: 1 } })).status).toBe(400);
    const tracking = await proposal(a.ws, "add_tracking", {
      capture_id: "X1",
      carrier: "UPS",
      tracking_number: "1Z",
      notify_payer: false,
    });
    // M3-03: add_tracking is executable now; this payload has no order_id, so it is refused as invalid
    const r = await approve(a.cookie, tracking.id, { payload_sha256: tracking.payloadSha256 });
    expect(r).toMatchObject({
      status: 422,
      body: { error: { code: "invalid_payload", details: { refusal: "INVALID_PAYLOAD" } } },
    });
  });

  it("reject → rejected (audited, no job); a rejected action cannot be approved", async () => {
    const a = await demo();
    const row = await proposal(a.ws);
    const r = await read(
      await postReject(
        req(`/api/actions/${row.id}/reject`, { cookie: a.cookie, body: {} }),
        testDeps(),
        row.id,
      ),
    );
    expect(r).toMatchObject({ status: 200, body: { action: { state: "rejected" } } });
    expect((await actionAuditTrail(testDb(), a.ws, row.id)).at(-1)).toMatchObject({
      actor: "seller",
      action: "action.rejected",
    });
    expect(await approve(a.cookie, row.id, { payload_sha256: row.payloadSha256 })).toMatchObject({
      status: 409,
      body: { error: { code: "action_not_proposed", details: { refusal: "ACTION_NOT_PROPOSED" } } },
    });
  });

  it("accept-claim proposal: seller-created, bound to the dispute amount; approval needs exactly `64.00 USD`", async () => {
    const a = await demo();
    const d = await dispute(a.ws);
    const res = await read(
      await postAcceptClaimProposal(
        req(`/api/disputes/${d.id}/accept-claim-proposal`, {
          cookie: a.cookie,
          body: { note: "Refunding in full." },
        }),
        testDeps(),
        d.id,
      ),
    );
    expect(res.status).toBe(201);
    const action = res.body.action as { id: string; payload_sha256: string; payload: unknown };
    expect(res.body.action).toMatchObject({
      kind: "accept_claim",
      state: "proposed",
      createdBy: "seller",
      typedConfirmation: "64.00 USD",
    });
    expect(action.payload).toEqual({
      dispute_id: d.disputeId,
      note: "Refunding in full.",
      amount: { value: "64.00", currency_code: "USD" },
      accept_claim_type: "REFUND",
    });
    const sha = action.payload_sha256;
    expect(await approve(a.cookie, action.id, { payload_sha256: sha })).toMatchObject({
      status: 422,
      body: {
        error: { code: "typed_confirmation_required", details: { refusal: "TYPED_CONFIRMATION_REQUIRED" } },
      },
    });
    for (const typed of ["64 USD", "64.00", "64.00 usd", "120.00 USD"]) {
      expect(
        await approve(a.cookie, action.id, { payload_sha256: sha, typed_confirmation: typed }),
      ).toMatchObject({
        status: 422,
        body: {
          error: { code: "typed_confirmation_mismatch", details: { refusal: "TYPED_CONFIRMATION_MISMATCH" } },
        },
      });
    }
    expect(
      await approve(a.cookie, action.id, { payload_sha256: sha, typed_confirmation: "64.00 USD" }),
    ).toMatchObject({
      status: 200,
      body: { action: { state: "approved" } },
    });
    const trail = (await actionAuditTrail(testDb(), a.ws, action.id)).map((r) => `${r.actor}:${r.action}`);
    expect(trail[0]).toBe("seller:action.proposed");
    expect(trail.at(-1)).toBe("seller:action.approved");
  });

  it("accept-claim: an agent-created proposal is refused 403; no link → 409; another workspace's dispute → 404", async () => {
    const a = await demo();
    const b = await demo();
    const d = await dispute(a.ws);
    const payload = {
      dispute_id: d.disputeId,
      note: "x",
      amount: { value: "64.00", currency_code: "USD" },
      accept_claim_type: "REFUND",
    };
    const byAgent = await proposal(a.ws, "accept_claim", payload, await agentRun(a.ws));
    expect(
      await approve(a.cookie, byAgent.id, {
        payload_sha256: byAgent.payloadSha256,
        typed_confirmation: "64.00 USD",
      }),
    ).toMatchObject({
      status: 403,
      body: {
        error: { code: "agent_accept_claim_forbidden", details: { refusal: "AGENT_ACCEPT_CLAIM_FORBIDDEN" } },
      },
    });
    const propose = async (cookie: string, id: string) =>
      (
        await postAcceptClaimProposal(
          req(`/api/disputes/${id}/accept-claim-proposal`, { cookie, body: { note: "n" } }),
          testDeps(),
          id,
        )
      ).status;
    const noLink = await dispute(a.ws, ["provide_evidence"]);
    expect(await propose(a.cookie, noLink.id)).toBe(409);
    expect(await propose(b.cookie, d.id)).toBe(404);
  });

  it("the App Router modules serve the handlers (GET /api/actions/[id], POST approve / reject, accept-claim-proposal)", async () => {
    vi.stubEnv("APP_BASE_URL", ORIGIN);
    vi.stubEnv("SESSION_SECRET", "s".repeat(48));
    try {
      const a = await demo();
      const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
      const row = await proposal(a.ws);
      const getRoute = await import("./[id]/route.ts");
      const approveRoute = await import("./[id]/approve/route.ts");
      const rejectRoute = await import("./[id]/reject/route.ts");
      const acceptRoute = await import("../disputes/[id]/accept-claim-proposal/route.ts");
      const got = await getRoute.GET(
        req(`/api/actions/${row.id}`, { method: "GET", cookie: a.cookie }),
        ctx(row.id),
      );
      expect(got.status).toBe(200);
      expect(got.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
      const rej = await proposal(a.ws);
      expect(
        (
          await rejectRoute.POST(
            req(`/api/actions/${rej.id}/reject`, { cookie: a.cookie, body: {} }),
            ctx(rej.id),
          )
        ).status,
      ).toBe(200);
      const ok = await approveRoute.POST(
        req(`/api/actions/${row.id}/approve`, {
          cookie: a.cookie,
          body: { payload_sha256: row.payloadSha256 },
        }),
        ctx(row.id),
      );
      expect(ok.status).toBe(200);
      const d = await dispute(a.ws);
      const acc = await acceptRoute.POST(
        req(`/api/disputes/${d.id}/accept-claim-proposal`, { cookie: a.cookie, body: { note: "n" } }),
        ctx(d.id),
      );
      expect(acc.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
