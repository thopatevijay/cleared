// M1-05 AC: magic-link flow (msw replays the recorded live Resend response), no enumeration, allowlist.
import { loadFixture, responseText } from "@cleared/adapters/testing/fixture";
import { RESEND_EMAILS_URL } from "@cleared/adapters";
import { forWorkspace, platform } from "@cleared/db";
import { WorkspaceIdSchema } from "@cleared/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postMagicLink } from "../../src/server/handlers/magic-link.ts";
import { getVerify } from "../../src/server/handlers/verify.ts";
import { requireSession } from "../../src/server/session.ts";
import { cookieFrom, freshIp, req, testDb, testDeps, uniqueEmail } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

const fixture = loadFixture("resend/send-email");
const sent: { to: string[]; text: string; html: string }[] = [];
const server = setupServer(
  http.post(RESEND_EMAILS_URL, async ({ request }) => {
    sent.push((await request.json()) as { to: string[]; text: string; html: string });
    return new HttpResponse(responseText(fixture), {
      status: fixture.response.status,
      headers: fixture.response.headers,
    });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  sent.length = 0;
});
afterAll(() => {
  server.close();
});

const tokenIn = (text: string): string => {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(text);
  if (m?.[1] === undefined) throw new Error("no token in the email body");
  return m[1];
};

async function requestLink(email: string, deps = testDeps({ config: { emailAllowlist: [email] } })) {
  return postMagicLink(
    req("/api/auth/magic-link", { body: { email, timezone: "Asia/Kolkata" }, ip: freshIp() }),
    deps,
  );
}

describe.skipIf(!dbAvailable)("magic link (integration)", () => {
  it("request → token from the intercepted Resend body → verify sets the cookie → requireSession passes", async () => {
    const email = uniqueEmail("flow");
    const deps = testDeps({ config: { emailAllowlist: [email] } });
    const res = await requestLink(email, deps);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([email]);
    const token = tokenIn(sent[0]?.text ?? "");

    const verified = await getVerify(req(`/api/auth/verify?token=${token}`, { method: "GET" }), deps);
    expect(verified.status).toBe(303);
    const session = await requireSession(
      req("/api/workspace", { method: "GET", cookie: cookieFrom(verified) }),
      deps,
    );
    expect(session).not.toBeInstanceOf(Response);
    if (session instanceof Response) return;
    expect(session.kind).toBe("seller");
    // the first verify of a new email created the seller workspace from the link's tz
    const ws = await platform(testDb()).workspaces.get(session.workspaceId);
    expect(ws).toMatchObject({ kind: "seller", timezone: "Asia/Kolkata", locale: "en" });

    const again = await getVerify(req(`/api/auth/verify?token=${token}`, { method: "GET" }), deps);
    expect(again.status).toBe(400);
  });

  it("a token used after 15 minutes (injected clock) → 400", async () => {
    const email = uniqueEmail("late");
    await requestLink(email);
    const token = tokenIn(sent[0]?.text ?? "");
    const later = testDeps({ now: () => new Date(Date.now() + 16 * 60_000) });
    const res = await getVerify(req(`/api/auth/verify?token=${token}`, { method: "GET" }), later);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_link" } });
  });

  it("a malformed or unknown token → 400", async () => {
    const deps = testDeps();
    expect((await getVerify(req("/api/auth/verify?token=x", { method: "GET" }), deps)).status).toBe(400);
    const unknown = "A".repeat(43);
    expect((await getVerify(req(`/api/auth/verify?token=${unknown}`, { method: "GET" }), deps)).status).toBe(
      400,
    );
  });

  it("known and unknown emails get byte-identical responses (no enumeration)", async () => {
    const db = testDb();
    const ws = await platform(db).workspaces.create({ kind: "seller", timezone: "UTC", baseCurrency: "USD" });
    const known = uniqueEmail("known");
    await forWorkspace(db, WorkspaceIdSchema.parse(ws.id)).users.insert({ email: known });
    const unknown = uniqueEmail("unknown");
    const deps = testDeps({ config: { emailAllowlist: [known, unknown] } });
    const a = await requestLink(known, deps);
    const b = await requestLink(unknown, deps);
    expect(a.status).toBe(b.status);
    expect(a.headers.get("content-type")).toBe(b.headers.get("content-type"));
    expect(Buffer.from(await a.arrayBuffer())).toEqual(Buffer.from(await b.arrayBuffer()));
    expect(sent).toHaveLength(2);
  });

  it("a non-allowlisted address: no Resend request, and the same 200", async () => {
    const deps = testDeps({ config: { emailAllowlist: ["owner@example.test"] } });
    const res = await requestLink(uniqueEmail("stranger"), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(sent).toHaveLength(0);
  });

  it("rate limit: the 6th link for one email in an hour → 429 with Retry-After", async () => {
    const email = uniqueEmail("busy");
    const deps = testDeps({ config: { emailAllowlist: ["owner@example.test"] } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await requestLink(email, deps)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const capped = await requestLink(email, deps);
    expect(capped.headers.get("retry-after")).toBe("3600");
  });

  it("an invalid email or time zone → 400", async () => {
    const deps = testDeps();
    const bad = await postMagicLink(
      req("/api/auth/magic-link", { body: { email: "nope" }, ip: freshIp() }),
      deps,
    );
    expect(bad.status).toBe(400);
    const tz = await postMagicLink(
      req("/api/auth/magic-link", {
        body: { email: uniqueEmail("tz"), timezone: "Mars/Olympus" },
        ip: freshIp(),
      }),
      deps,
    );
    expect(tz.status).toBe(400);
  });
});
