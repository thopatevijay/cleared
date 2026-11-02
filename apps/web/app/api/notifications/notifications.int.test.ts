// M3-08: GET / PATCH /api/notifications are workspace-scoped and zod-validated. Another workspace's session
// sees none of these rows and cannot mark them read; the sentence is the core template's (EN or HI), as
// plain text; mark one / mark all update the unread count; bad input is a 400, no session a 401.
import { deadlineAlert, holdOpenedNotification, WorkspaceIdSchema, type Instant } from "@cleared/core";
import { forWorkspace } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import type { NotificationsData, NotificationsPatched } from "../../../src/lib/notifications-view.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getNotifications, patchNotifications } from "../../../src/server/handlers/notifications.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";

const created: string[] = [];
const DUE = "2026-11-09T04:59:59.000Z" as Instant;

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

async function seed(ws: string): Promise<{ holdNote: string; deadlineNote: string }> {
  const repo = forWorkspace(testDb(), WorkspaceIdSchema.parse(ws)).notifications;
  const id = crypto.randomUUID();
  const hold = await repo.insertOnce(
    holdOpenedNotification({
      holdId: id,
      paymentId: id,
      amount: { amount: "64.00", currency: "USD" },
      reason: "<b>PENDING_REVIEW</b>",
    }),
  );
  const alert = deadlineAlert({
    disputeRowId: crypto.randomUUID(),
    dueDate: DUE,
    open: true,
    now: "2026-11-08T10:00:00.000Z" as Instant,
    amount: { amount: "120.00", currency: "USD" },
    reason: null,
  });
  const deadline = alert === null ? null : await repo.insertOnce(alert);
  if (hold === null || deadline === null) throw new Error("seed");
  return { holdNote: hold.id, deadlineNote: deadline.id };
}

const get = async (cookie: string, query = "") => {
  const res = await getNotifications(
    req(`/api/notifications${query}`, { method: "GET", cookie }),
    testDeps(),
  );
  return { status: res.status, body: (await res.json()) as NotificationsData };
};
const patch = async (cookie: string, body: unknown, init: { origin?: string | null } = {}) => {
  const res = await patchNotifications(
    req("/api/notifications", { method: "PATCH", cookie, body, ...init }),
    testDeps(),
  );
  return { status: res.status, body: (await res.json()) as NotificationsPatched };
};

describe.skipIf(!dbAvailable)("GET/PATCH /api/notifications (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("lists the session's workspace only, with the unread count and template sentences (EN, HI)", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seed(a.ws);
    const own = await get(a.cookie);
    expect(own.status).toBe(200);
    expect(own.body.unread).toBe(2);
    const hold = own.body.items.find((i) => i.id === s.holdNote);
    expect(hold).toMatchObject({ kind: "hold_opened", read: false, emailNotSent: false });
    // plain text: the reason code is never markup
    expect(hold?.sentence).toBe("PayPal is holding $64.00 USD (<b>PENDING_REVIEW</b>).");
    expect(hold?.href).toMatch(/^\/payments\/[0-9a-f-]{36}$/);
    const hi = await get(a.cookie, "?locale=hi");
    expect(hi.body.items.find((i) => i.id === s.holdNote)?.sentence).toContain("रोका है");
    const other = await get(b.cookie);
    expect(other.body.items.some((i) => i.id === s.holdNote || i.id === s.deadlineNote)).toBe(false);
    expect(other.body.unread).toBe(0);
  });

  it("mark one, then mark all; another workspace cannot mark these read", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seed(a.ws);
    expect((await patch(b.cookie, { ids: [s.holdNote, s.deadlineNote] })).body).toEqual({
      updated: 0,
      unread: 0,
    });
    expect((await patch(a.cookie, { ids: [s.holdNote] })).body).toEqual({ updated: 1, unread: 1 });
    expect((await get(a.cookie)).body.items.find((i) => i.id === s.holdNote)?.read).toBe(true);
    expect((await patch(a.cookie, { all: true })).body).toEqual({ updated: 1, unread: 0 });
  });

  it("validates input (zod) and needs a session and a same-origin mutation", async () => {
    const a = await demo();
    expect((await get(a.cookie, "?locale=fr")).status).toBe(400);
    expect((await get(a.cookie, "?limit=500")).status).toBe(400);
    expect((await patch(a.cookie, { ids: ["not-a-uuid"] })).status).toBe(400);
    expect((await patch(a.cookie, { all: false })).status).toBe(400);
    expect((await patch(a.cookie, { all: true, workspaceId: a.ws })).status).toBe(400);
    expect((await patch(a.cookie, { all: true }, { origin: "https://evil.example" })).status).toBe(403);
    const anon = await getNotifications(req("/api/notifications", { method: "GET" }), testDeps());
    expect(anon.status).toBe(401);
  });
});
