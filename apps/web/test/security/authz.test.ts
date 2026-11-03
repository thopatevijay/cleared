// M4-05 authZ suite. Every API route the app serves (read from app/**/route.ts, test/security/
// route-manifest.ts) has exactly one case here, or the suite fails: a new route cannot ship without one.
// Each scoped route is called through its real route module (withRoute + getDeps from the environment):
//   - with workspace A's session against workspace B's ids → 404 (no existence leak);
//   - with no session → 401 (mutations carry a valid Origin, JSON and Idempotency-Key, so the CSRF
//     check passes and the session check is what refuses);
//   - list routes, with A's session, never return one of B's ids.
// Public routes name the reason they are public and the suite that proves their own guard.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { holdOpenedNotification, WorkspaceIdSchema, type WorkspaceId } from "@cleared/core";
import { forWorkspace } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedCash } from "../support/cash-seed.ts";
import { cookieFrom, freshIp, ORIGIN, req, testDb } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";
import { seedDispute } from "../support/dispute-seed.ts";
import { coverageGaps, routeManifest } from "./route-manifest.ts";

const APP = fileURLToPath(new URL("../../app/", import.meta.url));

/** B's resource ids, one per kind a route takes. */
interface Ids {
  readonly ws: string;
  readonly dispute: string;
  readonly action: string;
  readonly evidence: string;
  readonly hold: string;
  readonly pack: string;
  readonly scenario: string;
  readonly link: string;
  readonly notification: string;
}

type Params = (b: Ids) => Record<string, string>;
type Case =
  | { readonly access: "public"; readonly why: string }
  /** id in the path: A → 404 on B's id; no session → 401 */
  | { readonly access: "scoped"; readonly params: Params; readonly body?: (b: Ids) => unknown; readonly multipart?: true }
  /** no id in the path: A's response never carries B's ids; no session → 401 */
  | { readonly access: "list"; readonly query?: string }
  /** no id in path or body (the workspace comes from the session): no session → 401 */
  | { readonly access: "self"; readonly body?: unknown };

const id: Params = (b) => ({ id: b.dispute });
/** +-30 days around today, the calendar's required `from`/`to` (seedCash puts B's events inside it). */
function calendarRange(): string {
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  return `?from=${day(-30)}&to=${day(30)}`;
}
const action: Params = (b) => ({ id: b.action });
const hold: Params = (b) => ({ id: b.hold });
const pack: Params = (b) => ({ packId: b.pack });

export const CASES: Record<string, Case> = {
  "POST /api/ack/[token]": { access: "public", why: "the client's capability token (test/ack.int.test.ts)" },
  "POST /api/auth/magic-link": { access: "public", why: "sign-in; caps + allowlist (test/auth/magic-link.int.test.ts)" },
  "GET /api/auth/verify": { access: "public", why: "single-use token (test/auth/magic-link.int.test.ts)" },
  "POST /api/demo": { access: "public", why: "creates a workspace; caps (test/security/caps.test.ts)" },
  "POST /api/webhooks/paypal": { access: "public", why: "PayPal signature (test/webhooks/paypal-webhook.int.test.ts)" },
  "GET /healthz": { access: "public", why: "liveness probe, no data" },
  "GET /readyz": { access: "public", why: "readiness probe, no data" },

  "GET /api/actions/[id]": { access: "scoped", params: action },
  "POST /api/actions/[id]/approve": {
    access: "scoped",
    params: action,
    body: () => ({ payload_sha256: "0".repeat(64) }),
  },
  "POST /api/actions/[id]/reject": { access: "scoped", params: action, body: () => ({}) },
  "GET /api/disputes/[id]": { access: "scoped", params: id },
  "POST /api/disputes/[id]/accept-claim-proposal": {
    access: "scoped",
    params: id,
    body: () => ({ note: "Refunding the buyer." }),
  },
  "GET /api/disputes/[id]/draft/pdf": { access: "scoped", params: id },
  "POST /api/disputes/[id]/draft/revise": {
    access: "scoped",
    params: id,
    body: (b) => ({ draft_id: randomUUID(), notes: "Shorter, please.", evidence_item_ids: [b.evidence] }),
  },
  "GET /api/evidence/[id]/file": { access: "scoped", params: (b) => ({ id: b.evidence }) },
  "GET /api/holds/[id]": { access: "scoped", params: hold },
  "POST /api/holds/[id]/completed": {
    access: "scoped",
    params: hold,
    body: () => ({ confirmed_on: "2026-11-01" }),
  },
  "POST /api/holds/[id]/completed/record": { access: "scoped", params: hold, body: () => ({}) },
  "POST /api/holds/[id]/declaration": { access: "scoped", params: hold, body: () => ({ kind: "goods" }) },
  "POST /api/holds/[id]/explanation": { access: "scoped", params: hold, body: () => ({ locale: "en" }) },
  "POST /api/holds/[id]/tracking": {
    access: "scoped",
    params: hold,
    body: () => ({ carrier: "UPS", tracking_number: "1Z999AA10123456784" }),
  },
  "GET /api/packs/[packId]": { access: "scoped", params: pack },
  "GET /api/packs/[packId]/ack-links": { access: "scoped", params: pack },
  "POST /api/packs/[packId]/ack-links": { access: "scoped", params: pack, body: () => ({}) },
  "POST /api/packs/[packId]/ack-links/[linkId]/revoke": {
    access: "scoped",
    params: (b) => ({ packId: b.pack, linkId: b.link }),
    body: () => ({}),
  },
  "GET /api/packs/[packId]/evidence": { access: "scoped", params: pack },
  "POST /api/packs/[packId]/evidence/text": {
    access: "scoped",
    params: pack,
    body: () => ({ kind: "communication", text: "Buyer: thanks, it arrived." }),
  },
  "POST /api/packs/[packId]/evidence/upload": { access: "scoped", params: pack, multipart: true },
  "GET /api/packs/[packId]/scope-snapshot": { access: "scoped", params: pack },
  "POST /api/packs/[packId]/scope-snapshot": { access: "scoped", params: pack, body: () => ({}) },
  "GET /api/scenarios/[id]": { access: "scoped", params: (b) => ({ id: b.scenario }) },
  "POST /api/scenarios/[id]/decide": { access: "scoped", params: (b) => ({ id: b.scenario }), body: () => ({}) },

  "GET /api/audit": { access: "list" },
  "GET /api/cash-calendar": { access: "list", query: calendarRange() },
  "GET /api/disputes": { access: "list" },
  "GET /api/holds": { access: "list" },
  "GET /api/notifications": { access: "list" },
  "GET /api/payments": { access: "list" },
  "GET /api/scenarios": { access: "list" },
  "GET /api/workspace": { access: "list" },

  "POST /api/auth/sign-out": { access: "self", body: {} },
  "PATCH /api/notifications": { access: "self", body: { all: true } },
  "POST /api/sandbox/test-payments": { access: "self", body: {} },
  "POST /api/scenarios": { access: "self", body: {} },
};

describe("route coverage", () => {
  it("every route in app/ has exactly one authZ case, and every case names a served route", () => {
    expect(coverageGaps(routeManifest(APP), Object.keys(CASES))).toEqual({ uncovered: [], stale: [] });
  });

  it("a planted route without a case is reported (and so fails the test above)", () => {
    const dir = mkdtempSync(join(tmpdir(), "m405-routes-"));
    try {
      mkdirSync(join(dir, "api", "planted", "[id]"), { recursive: true });
      writeFileSync(join(dir, "api", "planted", "[id]", "route.ts"), "export async function DELETE() {}\n");
      mkdirSync(join(dir, "(group)", "api", "grouped"), { recursive: true });
      writeFileSync(join(dir, "(group)", "api", "grouped", "route.ts"), "export const GET = () => null;\n");
      const gaps = coverageGaps(routeManifest(dir), Object.keys(CASES));
      expect(gaps.uncovered).toEqual(["DELETE /api/planted/[id]", "GET /api/grouped"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type RouteFn = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  key: string,
  init: { params?: Record<string, string>; cookie?: string; body?: unknown; multipart?: true; query?: string },
) {
  const [method = "GET", template = "/"] = key.split(" ");
  const mod = (await import(/* @vite-ignore */ join(APP, template, "route.ts"))) as Record<string, RouteFn>;
  const fn = mod[method];
  if (fn === undefined) throw new Error(`${key}: no export`);
  const params = init.params ?? {};
  const path = template.replace(/\[(\w+)\]/g, (_, k: string) => params[k] ?? k);
  // B's workspace id smuggled in the query: the workspace must come from the session only.
  const q = init.query ?? `?workspaceId=${encodeURIComponent(ws.b?.ws ?? "")}`;
  let request: Request;
  if (init.multipart === true) {
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("%PDF-1.4\n%%EOF\n")], { type: "application/pdf" }), "a.pdf");
    form.set("kind", "communication");
    request = new Request(`${ORIGIN}${path}${q}`, {
      method,
      body: form,
      headers: {
        origin: ORIGIN,
        "idempotency-key": randomUUID(),
        ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      },
    });
  } else {
    request = req(`${path}${q}`, {
      method,
      ...(method === "GET" ? {} : { body: init.body ?? {} }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    });
  }
  return fn(request, { params: Promise.resolve(params) });
}

const ws: { a?: string; b?: Ids; bCookie?: string } = {};

async function demo(): Promise<{ cookie: string; ws: WorkspaceId }> {
  const res = await call("POST /api/demo", { body: {} }).catch(() => null);
  if (res === null) throw new Error("demo");
  return { cookie: cookieFrom(res), ws: WorkspaceIdSchema.parse(await workspaceOf(cookieFrom(res))) };
}

async function workspaceOf(cookie: string): Promise<string> {
  const res = await call("GET /api/workspace", { cookie });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

describe.skipIf(!dbAvailable)("authZ: every route, A's session on B's ids, and no session", () => {
  beforeAll(async () => {
    vi.stubEnv("APP_BASE_URL", ORIGIN);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("DEMO_WORKSPACES_PER_IP_PER_DAY", "100000");
    vi.stubEnv("DEMO_WORKSPACES_GLOBAL_MAX", "1000000");
    // Each demo request comes from its own address (the per-IP cap is caps.test.ts's subject).
    const a = await demoFrom(freshIp());
    const b = await demoFrom(freshIp());
    ws.a = a.cookie;
    ws.bCookie = b.cookie;
    ws.b = await seedB(b.ws, b.cookie);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  async function demoFrom(ip: string): Promise<{ cookie: string; ws: WorkspaceId }> {
    const mod = (await import(join(APP, "api/demo/route.ts"))) as Record<string, RouteFn>;
    const res = await (mod["POST"] as RouteFn)(req("/api/demo", { ip, body: {} }), { params: Promise.resolve({}) });
    const cookie = cookieFrom(res);
    return { cookie, ws: WorkspaceIdSchema.parse(await workspaceOf(cookie)) };
  }

  const keys = (access: Case["access"]) =>
    Object.entries(CASES)
      .filter(([, c]) => c.access === access)
      .map(([k]) => k);

  it.each(keys("scoped"))("%s: A's session on B's id → 404", async (key) => {
    const c = CASES[key] as Extract<Case, { access: "scoped" }>;
    const b = ws.b as Ids;
    const res = await call(key, {
      params: c.params(b),
      cookie: ws.a as string,
      ...(c.body === undefined ? {} : { body: c.body(b) }),
      ...(c.multipart === true ? { multipart: true as const } : {}),
    });
    expect(res.status, `${key} → ${await res.clone().text()}`).toBe(404);
    expect(await leaks(res)).toEqual([]);
  });

  it.each([...keys("scoped"), ...keys("list"), ...keys("self")])("%s: no session → 401", async (key) => {
    const c = CASES[key] as Exclude<Case, { access: "public" }>;
    const b = ws.b as Ids;
    const res = await call(key, {
      ...(c.access === "scoped" ? { params: c.params(b) } : {}),
      ...(c.access === "scoped" && c.body !== undefined ? { body: c.body(b) } : {}),
      ...(c.access === "self" ? { body: c.body } : {}),
      ...(c.access === "scoped" && c.multipart === true ? { multipart: true as const } : {}),
    });
    expect(res.status, `${key} → ${await res.clone().text()}`).toBe(401);
  });

  it.each(keys("list"))("%s: A's list never carries B's ids", async (key) => {
    const c = CASES[key] as Extract<Case, { access: "list" }>;
    const query = c.query === undefined ? {} : { query: c.query };
    const res = await call(key, { cookie: ws.a as string, ...query });
    expect(res.status).toBe(200);
    expect(await leaks(res)).toEqual([]);
    // B's own list does show B's data (the check above is not vacuous for the lists that hold it).
    if (key === "GET /api/holds" || key === "GET /api/disputes") {
      const own = await (await call(key, { cookie: ws.bCookie as string })).text();
      expect(own).toContain(key === "GET /api/holds" ? (ws.b as Ids).hold : (ws.b as Ids).dispute);
    }
  });

  it("B's resources are untouched by A's calls (B still reads its own hold and dispute)", async () => {
    const b = ws.b as Ids;
    expect((await call("GET /api/holds/[id]", { params: { id: b.hold }, cookie: ws.bCookie as string })).status).toBe(200);
    expect((await call("GET /api/disputes/[id]", { params: { id: b.dispute }, cookie: ws.bCookie as string })).status).toBe(200);
  });
});

/** Any of B's ids in a response body. */
async function leaks(res: Response): Promise<string[]> {
  const text = await res.clone().text();
  const b = ws.b as Ids;
  return Object.values(b).filter((v) => v !== "" && text.includes(v));
}

async function seedB(wsB: WorkspaceId, cookie: string): Promise<Ids> {
  const db = testDb();
  const d = await seedDispute(db, wsB);
  const cash = await seedCash(db, wsB, new Date());
  const r = forWorkspace(db, wsB);
  const pack =
    (await r.proofPacks.getByPaymentId(d.paymentId)) ??
    (await r.proofPacks.insert({ paymentId: d.paymentId, state: "collecting" }));
  const scenario = await r.scenarioRuns.insert({});
  const note = await r.notifications.insertOnce(
    holdOpenedNotification({
      holdId: cash.review.holdId,
      paymentId: d.paymentId,
      amount: { amount: "64.00", currency: "USD" },
      reason: "PENDING_REVIEW",
    }),
  );
  const linkRes = await call("POST /api/packs/[packId]/ack-links", { params: { packId: pack.id }, cookie, body: {} });
  const linkId = ((await linkRes.json()) as { view: { link?: { id: string } } }).view.link?.id;
  if (note === null || linkId === undefined) throw new Error(`seed B: link ${String(linkRes.status)}`);
  return {
    ws: wsB,
    dispute: d.disputeRowId,
    action: d.actionId,
    evidence: d.itemIds[0] ?? "",
    hold: cash.review.holdId,
    pack: pack.id,
    scenario: scenario.id,
    link: linkId,
    notification: note.id,
  };
}
