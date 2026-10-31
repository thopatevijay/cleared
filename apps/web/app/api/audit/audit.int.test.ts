// M2-09 AC 7 (server side) and AC 8: GET /api/audit is workspace-scoped (another workspace's session sees
// none of these rows), newest first with a 50-row cursor, filtered by actor / kind / an ID fragment (dispute
// ID, debug_id), and returns only allow-listed scalar detail fields: a `<script>` in a code stays a string,
// and evidence text, notes or buyer messages in a detail never leave the server.
import { WorkspaceIdSchema } from "@cleared/core";
import { forWorkspace } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import type { AuditPageData } from "../../../src/lib/dispute-view.ts";
import { getAudit } from "../../../src/server/handlers/audit.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";
import { seedDispute } from "../../../test/support/dispute-seed.ts";

const created: string[] = [];

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

const audit = async (cookie: string, query = "") => {
  const res = await getAudit(req(`/api/audit${query}`, { method: "GET", cookie }), testDeps());
  return { status: res.status, body: (await res.json()) as AuditPageData };
};

async function row(
  ws: string,
  actor: "seller" | "agent" | "system",
  action: string,
  detail: Record<string, unknown>,
) {
  await forWorkspace(testDb(), WorkspaceIdSchema.parse(ws)).auditLog.insert({ actor, action, detail });
}

describe.skipIf(!dbAvailable)("GET /api/audit (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("is workspace-scoped: another workspace's session gets none of these rows; no session is 401", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedDispute(testDb(), a.ws);
    await row(a.ws, "system", "action.sent", { actionId: s.actionId, status: 200, debugId: "dbg-iso-1" });
    const own = await audit(a.cookie);
    expect(own.body.items.map((i) => i.action)).toContain("action.sent");
    const other = await audit(b.cookie);
    const ids = new Set(own.body.items.map((i) => i.id));
    expect(other.body.items.some((i) => ids.has(i.id))).toBe(false);
    expect(other.body.items.some((i) => i.refs.disputeId === s.paypalDisputeId)).toBe(false);
    expect((await audit(b.cookie, `?q=${s.paypalDisputeId}`)).body.items).toEqual([]);
    expect((await getAudit(req("/api/audit", { method: "GET" }), testDeps())).status).toBe(401);
  });

  it("returns allow-listed scalar detail only: a <script> stays a string; evidence text and messages never leave", async () => {
    const a = await demo();
    await row(a.ws, "system", "action.failed", {
      code: "<script>alert(1)</script>",
      notes: "the buyer wrote: call me at +1 555 0100",
      text: "evidence text",
      message: "buyer message",
      reason: "the model said something long and free-form",
      nested: { x: 1 },
    });
    const e = (await audit(a.cookie)).body.items.find((i) => i.action === "action.failed");
    expect(e?.detail).toEqual({ code: "<script>alert(1)</script>" });
    expect(JSON.stringify(e)).not.toMatch(/buyer|evidence text|555 0100|free-form/);
  });

  it("orders newest first and pages 50 at a time with a cursor; a bad cursor or filter is 400", async () => {
    const a = await demo();
    await testDb().$client.query(
      "insert into audit_log (workspace_id, actor, action, detail, at) select $1, 'system', 'action.check', jsonb_build_object('check','deadline','ok',true,'attempt',g), clock_timestamp() from generate_series(1,55) g",
      [a.ws],
    );
    const first = await audit(a.cookie, "?kind=disputes");
    expect(first.body.items).toHaveLength(50);
    const ats = first.body.items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(first.body.next).not.toBeNull();
    const second = await audit(a.cookie, `?kind=disputes&cursor=${String(first.body.next)}`);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.next).toBeNull();
    const seen = new Set([...first.body.items, ...second.body.items].map((i) => i.id));
    expect(seen.size).toBe(55);
    expect((await audit(a.cookie, "?cursor=nonsense")).status).toBe(400);
    expect((await audit(a.cookie, "?actor=robot")).status).toBe(400);
    expect((await audit(a.cookie, "?q=<x>")).status).toBe(400);
  });

  it("filters by actor, kind and an ID fragment (dispute ID, debug_id)", async () => {
    const a = await demo();
    const s = await seedDispute(testDb(), a.ws); // agent: action.proposed for the dispute
    await row(a.ws, "seller", "action.approved", { actionId: s.actionId, payloadSha256: s.payloadSha256 });
    await row(a.ws, "system", "action.sent", { actionId: s.actionId, status: 200, debugId: "f1a2b3c4d5e6" });
    await row(a.ws, "seller", "scenario.decision_requested", { sandbox_decision: true, scenarioId: "x" });
    await row(a.ws, "seller", "sandbox.test_payment.requested", { messageId: "m" });
    const actions = async (q: string) => (await audit(a.cookie, q)).body.items.map((i) => i.action).sort();
    expect(await actions("?actor=agent")).toEqual(["action.proposed"]);
    expect(await actions("?actor=seller")).toEqual(["action.approved", "sandbox.test_payment.requested"]);
    expect(await actions("?actor=sandbox")).toEqual(["scenario.decision_requested"]);
    expect(await actions("?kind=sandbox")).toEqual([
      "sandbox.test_payment.requested",
      "scenario.decision_requested",
    ]);
    expect(await actions("?kind=disputes")).toEqual(["action.approved", "action.proposed", "action.sent"]);
    expect(await actions("?kind=tracking")).toEqual([]);
    expect(await actions(`?q=${s.paypalDisputeId}`)).toEqual([
      "action.approved",
      "action.proposed",
      "action.sent",
    ]);
    expect(await actions("?q=f1a2b3c4d5e6")).toEqual(["action.sent"]);
    expect(await actions(`?q=${s.payloadSha256.slice(0, 8)}`)).toEqual([
      "action.approved",
      "action.proposed",
    ]);
    expect(await actions("?actor=agent&kind=sandbox")).toEqual([]);
    const sent = (await audit(a.cookie, "?q=f1a2b3c4d5e6")).body.items[0];
    expect(sent?.refs).toMatchObject({ disputeId: s.paypalDisputeId, debugId: "f1a2b3c4d5e6" });
  });
});
