// M3-06 integration: the client acknowledgement link against the compose Postgres. Seller routes create,
// read and revoke a link; the public POST accepts it. Each AC has its own block.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ACK_RATE_PER_IP,
  AckLinkCreatedSchema,
  AckLinkViewSchema,
  ackTokenHash,
  WorkspaceIdSchema,
  type PackState,
  type WorkspaceId,
} from "@cleared/core";
import { evidenceSha256 } from "@cleared/adapters/files";
import { createPublisher, createQueue, forWorkspace, type Publisher } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACK_NEUTRAL_BODY,
  ACK_NEUTRAL_STATUS,
  DEMO_SELLER_NAME,
  loadPublicAck,
  postAck,
} from "../src/server/handlers/ack.ts";
import { getAckLinks, postAckLink, postAckRevoke } from "../src/server/handlers/ack-links.ts";
import { postDemo } from "../src/server/handlers/demo.ts";
import { getWorkspace } from "../src/server/handlers/session-routes.ts";
import type { Deps } from "../src/server/deps.ts";
import { cookieFrom, freshIp, ORIGIN, req, testDb, testDeps } from "./support/db.ts";
import { dbAvailable } from "./support/db-available.ts";

/** A well-formed token no link has (fresh per call: rate-limit hits persist across runs). */
const unknownToken = (): string => randomBytes(32).toString("base64url");

const SCOPE = "Three logo concepts and two rounds of revisions.\n<script>alert(1)</script>";

let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};
const created: string[] = [];
const q = async <T>(sql: string, params: unknown[]): Promise<T[]> =>
  (await testDb().$client.query(sql, params)).rows as T[];

interface Seller {
  readonly cookie: string;
  readonly wsId: WorkspaceId;
  readonly packId: string;
}

async function seller(state: PackState = "checked", scope: string | null = SCOPE): Promise<Seller> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const wsId = WorkspaceIdSchema.parse(((await res.json()) as { workspace: { id: string } }).workspace.id);
  created.push(wsId);
  const r = forWorkspace(testDb(), wsId);
  const payment = await r.payments.insert({
    captureId: randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(),
    amount: "120.00",
    currency: "USD",
    status: "COMPLETED",
    source: "webhook",
  });
  const pack = await r.proofPacks.insert({ paymentId: payment.id, state });
  if (scope !== null) await addScope(wsId, pack.id, scope);
  return { cookie, wsId, packId: pack.id };
}

async function addScope(wsId: WorkspaceId, packId: string, text: string): Promise<void> {
  await forWorkspace(testDb(), wsId).evidenceItems.insert({
    packId,
    kind: "scope",
    sha256: evidenceSha256({ kind: "text", text }),
    text,
  });
}

const create = (s: Seller, deps: Deps = testDeps()) =>
  postAckLink(req(`/api/packs/${s.packId}/ack-links`, { cookie: s.cookie, body: {} }), deps, s.packId);

async function link(s: Seller, deps?: Deps): Promise<{ token: string; id: string }> {
  const res = await create(s, deps);
  expect(res.status).toBe(201);
  const body = AckLinkCreatedSchema.parse(await res.json());
  const token = body.url.split("/ack/")[1] ?? "";
  return { token, id: body.view.link?.id ?? "" };
}

const accept = (token: string, opts: { ip?: string; deps?: Deps; body?: unknown; origin?: string } = {}) =>
  postAck(
    req(`/api/ack/${token}`, {
      body: opts.body ?? { name: "Asha Rao", agree: true },
      ip: opts.ip ?? freshIp(),
      key: null,
      origin: opts.origin ?? ORIGIN,
      headers: { "user-agent": "Mozilla/5.0 (M3-06 test)" },
    }),
    opts.deps ?? testDeps(),
    publisher,
    token,
  );

const ackItems = (wsId: string) =>
  q<{ id: string; text: string; sha256: string }>(
    "select id, text, sha256 from evidence_items where workspace_id = $1 and kind = 'client_ack'",
    [wsId],
  );
const ackOutbox = (wsId: string) =>
  q<{ id: string }>(
    "select id from outbox where topic = 'evidence.added' and payload->>'workspaceId' = $1 and payload->'data'->>'kind' = 'client_ack'",
    [wsId],
  );
const packState = async (packId: string): Promise<string | undefined> =>
  (await q<{ state: string }>("select state from proof_packs where id = $1", [packId]))[0]?.state;

describe.skipIf(!dbAvailable)("client acknowledgement link (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query(
      "delete from pgboss.job where name = 'evidence.added' and data->'data'->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("AC1: create → accept writes one acceptance and one client_ack item whose sha256 matches its text; a second submit is a no-op", async () => {
    const s = await seller("checked");
    const { token, id } = await link(s);
    const first = await accept(token);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { status: string; acceptedAt: string };
    expect(body.status).toBe("accepted");

    const acks = await q<{ accepted_at: Date; ip: string; user_agent: string; evidence_item_id: string }>(
      "select accepted_at, ip, user_agent, evidence_item_id from client_acks where id = $1",
      [id],
    );
    expect(acks).toHaveLength(1);
    expect(acks[0]?.accepted_at.toISOString()).toBe(body.acceptedAt);
    expect(acks[0]?.user_agent).toBe("Mozilla/5.0 (M3-06 test)");
    const items = await ackItems(s.wsId);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.id).toBe(acks[0]?.evidence_item_id);
    expect(item?.sha256).toBe(
      createHash("sha256")
        .update(item?.text ?? "", "utf8")
        .digest("hex"),
    );
    const scopeSha = evidenceSha256({ kind: "text", text: SCOPE });
    expect(JSON.parse(item?.text ?? "{}")).toEqual({
      accepted_at: body.acceptedAt,
      ip: acks[0]?.ip,
      scope_sha256: scopeSha,
      typed_name: "Asha Rao",
      user_agent: "Mozilla/5.0 (M3-06 test)",
    });

    const again = await accept(token, { body: { name: "Someone Else", agree: true } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { acceptedAt: string }).acceptedAt).toBe(body.acceptedAt);
    expect(await ackItems(s.wsId)).toHaveLength(1);
    expect(await ackOutbox(s.wsId)).toHaveLength(1);
    const audit = await q<{ action: string }>(
      "select action from audit_log where workspace_id = $1 and action like 'ack%' order by at",
      [s.wsId],
    );
    expect(audit.map((a) => a.action)).toEqual(["ack_link.created", "ack.accepted"]);

    // The seller's view now shows the acceptance and points at the evidence item.
    const view = AckLinkViewSchema.parse(
      await (
        await getAckLinks(
          req(`/api/packs/${s.packId}/ack-links`, { method: "GET", cookie: s.cookie }),
          testDeps(),
          s.packId,
        )
      ).json(),
    );
    expect(view.link?.status).toBe("accepted");
    expect(view.link?.evidenceItemId).toBe(item?.id);
  });

  it("AC2: the raw token is never stored, only its sha256", async () => {
    const s = await seller();
    const { token, id } = await link(s);
    await accept(token);
    const [row] = await q<{ j: string }>("select row_to_json(c)::text j from client_acks c where id = $1", [
      id,
    ]);
    expect(row?.j).toContain(ackTokenHash(token));
    expect(row?.j).not.toContain(token);
    // nor anywhere else this workspace wrote: evidence, audit, outbox, idempotency keys
    const dumps = await q<{ j: string }>(
      `select row_to_json(t)::text j from evidence_items t where workspace_id = $1
       union all select row_to_json(t)::text from audit_log t where workspace_id = $1
       union all select row_to_json(t)::text from outbox t where payload->>'workspaceId' = $1::text
       union all select row_to_json(t)::text from idempotency_keys t where route like '%ack%'
       union all select row_to_json(t)::text from rate_limit_hits t`,
      [s.wsId],
    );
    expect(dumps.length).toBeGreaterThan(0);
    for (const d of dumps) expect(d.j).not.toContain(token);
  });

  it("AC3: expired, revoked, unknown and scope-changed tokens get the same neutral response and status", async () => {
    const later = (ms: number): Deps => testDeps({ now: () => new Date(Date.now() + ms) });
    const expired = await (async () => (await link(await seller())).token)();
    const revoked = await (async () => {
      const s = await seller();
      const l = await link(s);
      const res = await postAckRevoke(
        req(`/api/packs/${s.packId}/ack-links/${l.id}/revoke`, { cookie: s.cookie, body: {} }),
        testDeps(),
        s.packId,
        l.id,
      );
      expect(res.status).toBe(200);
      return l.token;
    })();
    const scopeChanged = await (async () => {
      const s = await seller();
      const l = await link(s);
      await addScope(s.wsId, s.packId, `${SCOPE}\nPlus a favicon.`);
      return l.token;
    })();
    const cases: [string, string, Deps][] = [
      ["expired", expired, later(31 * 24 * 3600 * 1000)],
      ["revoked", revoked, testDeps()],
      ["unknown", unknownToken(), testDeps()],
      ["malformed", "not-a-token", testDeps()],
      ["scope changed", scopeChanged, testDeps()],
    ];
    for (const [label, token, deps] of cases) {
      const res = await accept(token, { deps });
      expect(res.status, label).toBe(ACK_NEUTRAL_STATUS);
      expect(await res.json(), label).toEqual(ACK_NEUTRAL_BODY);
      expect(await loadPublicAck(deps, token), label).toBeNull();
    }
    expect(await ackItems(created.at(-1) ?? "")).toHaveLength(0);
  });

  it("AC3: the page shows a pending link and the neutral page once it is accepted", async () => {
    const s = await seller();
    const { token } = await link(s);
    expect(await loadPublicAck(testDeps(), token)).toEqual({
      sellerName: DEMO_SELLER_NAME, // BL-01 6569232529: a demo workspace has no users row
      amount: "120.00",
      currency: "USD",
      scopeText: SCOPE,
    });
    expect((await accept(token)).status).toBe(200);
    expect(await loadPublicAck(testDeps(), token)).toBeNull();
  });

  it("BL-01 6569232529: a stored display name wins; a seller workspace without one gets no name (the page's fallback)", async () => {
    const named = await seller();
    const { token: namedToken } = await link(named);
    await q("insert into users (workspace_id, email, display_name) values ($1, $2, $3)", [
      named.wsId,
      `ravi-${randomUUID()}@example.test`,
      "Ravi Prints",
    ]);
    expect((await loadPublicAck(testDeps(), namedToken))?.sellerName).toBe("Ravi Prints");

    const unnamed = await seller();
    const { token } = await link(unnamed);
    await q("update workspaces set kind = 'seller', expires_at = null where id = $1", [unnamed.wsId]);
    expect((await loadPublicAck(testDeps(), token))?.sellerName).toBeNull();
  });

  it("AC4: the accept route returns 429 after N attempts per IP", async () => {
    const ip = freshIp();
    // one deps: the IP bucket is an HMAC under the session secret, which testDeps() draws afresh
    const deps = testDeps();
    for (let i = 0; i < ACK_RATE_PER_IP; i++) {
      const res = await accept(unknownToken(), { ip, deps });
      expect(res.status).toBe(ACK_NEUTRAL_STATUS);
    }
    const limited = await accept(unknownToken(), { ip, deps });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");
    // another IP is unaffected
    expect((await accept(unknownToken(), { deps })).status).toBe(ACK_NEUTRAL_STATUS);
  });

  it("AC4: the accept route also limits attempts per token", async () => {
    const token = unknownToken();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await accept(token)).status);
    expect(statuses.slice(0, 10).every((st) => st === ACK_NEUTRAL_STATUS)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("AC6: the pack goes stale and the outbox row is written in the same transaction (a forced failure leaves neither)", async () => {
    const s = await seller("checked");
    const { token, id } = await link(s);
    const real = await publisher();
    const dying = (): Promise<Pick<Publisher, "emit">> =>
      Promise.resolve({
        emit: async (tx, event) => {
          const row = await real.emit(tx, event);
          throw new Error(`killed after outbox row ${row.id}`);
        },
      });
    const res = postAck(
      req(`/api/ack/${token}`, { body: { name: "Asha Rao", agree: true }, ip: freshIp(), key: null }),
      testDeps(),
      dying,
      token,
    );
    await expect(res).rejects.toThrow("killed after outbox row");
    expect(await packState(s.packId)).toBe("checked");
    expect(await ackOutbox(s.wsId)).toHaveLength(0);
    expect(await ackItems(s.wsId)).toHaveLength(0);
    const [ack] = await q<{ accepted_at: Date | null }>("select accepted_at from client_acks where id = $1", [
      id,
    ]);
    expect(ack?.accepted_at).toBeNull();

    // the same link then succeeds, and both land together
    expect((await accept(token)).status).toBe(200);
    expect(await packState(s.packId)).toBe("stale");
    expect(await ackOutbox(s.wsId)).toHaveLength(1);
  });

  it("refuses a wrong Origin, a non-JSON body and an invalid form", async () => {
    const s = await seller();
    const { token } = await link(s);
    expect((await accept(token, { origin: "https://evil.example" })).status).toBe(403);
    expect((await accept(token, { body: { name: "  ", agree: true } })).status).toBe(400);
    expect((await accept(token, { body: { name: "Asha", agree: false } })).status).toBe(400);
    const form = await postAck(
      new Request(`${ORIGIN}/api/ack/${token}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: "name=Asha&agree=true",
      }),
      testDeps(),
      publisher,
      token,
    );
    expect(form.status).toBe(415);
    expect(await ackItems(s.wsId)).toHaveLength(0);
  });

  it("seller routes: no scope → 409, one active link per scope item, revoke is audited and final, foreign pack → 404", async () => {
    const empty = await seller("empty", null);
    const none = await create(empty);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("ack_no_scope");

    const s = await seller();
    const l = await link(s);
    const dup = await create(s);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("ack_link_active");

    const revoke = () =>
      postAckRevoke(
        req(`/api/packs/${s.packId}/ack-links/${l.id}/revoke`, { cookie: s.cookie, body: {} }),
        testDeps(),
        s.packId,
        l.id,
      );
    const r1 = await revoke();
    expect(AckLinkViewSchema.parse(await r1.json()).link?.status).toBe("revoked");
    expect((await revoke()).status).toBe(409);
    expect((await create(s)).status).toBe(201); // a new link after revoking

    const other = await seller();
    expect((await create({ ...other, packId: s.packId })).status).toBe(404);
    expect(
      (
        await getAckLinks(
          req(`/api/packs/${s.packId}/ack-links`, { method: "GET", cookie: other.cookie }),
          testDeps(),
          s.packId,
        )
      ).status,
    ).toBe(404);
    const audit = await q<{ action: string }>(
      "select action from audit_log where workspace_id = $1 and action like 'ack%' order by at",
      [s.wsId],
    );
    expect(audit.map((a) => a.action)).toEqual(["ack_link.created", "ack_link.revoked", "ack_link.created"]);
  });

  it("an expired open link no longer blocks a new one, and the expiry is capped by the workspace expiry", async () => {
    const s = await seller();
    const first = await link(s);
    const res = await create(s, testDeps({ now: () => new Date(Date.now() + 31 * 24 * 3600 * 1000) }));
    expect(res.status).toBe(201);
    const view = AckLinkCreatedSchema.parse(await res.json()).view;
    expect(view.link?.id).not.toBe(first.id);
    const [ws] = await q<{ expires_at: Date | null }>("select expires_at from workspaces where id = $1", [
      s.wsId,
    ]);
    if (ws?.expires_at) {
      const [row] = await q<{ expires_at: Date }>("select expires_at from client_acks where id = $1", [
        first.id,
      ]);
      expect(row?.expires_at.getTime()).toBeLessThanOrEqual(ws.expires_at.getTime());
    }
  });
});
