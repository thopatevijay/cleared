import { describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";
import { createTokenProvider, hasScope, TRANSACTION_SEARCH_SCOPE, type TokenCache } from "./token.ts";

const BASE = "https://api.test";

function setup(expiresIn = 32_400) {
  let mints = 0;
  let clock = 0;
  const fetchImpl: typeof fetch = async (input) => {
    await new Promise((r) => setTimeout(r, 5)); // keep the mint in flight while callers pile up
    expect(input).toBe(`${BASE}/v1/oauth2/token`);
    mints += 1;
    const body = {
      access_token: `tok-${String(mints)}`,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: `a ${TRANSACTION_SEARCH_SCOPE}`,
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 1_000, fetch: fetchImpl });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({
    http,
    baseUrl: BASE,
    credentials: { clientId: "cid", clientSecret: "secret" },
    cache,
    now: () => clock,
  });
  return {
    tokens,
    cache,
    mints: () => mints,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createTokenProvider", () => {
  it("fetches once for N concurrent callers (single-flight)", async () => {
    const s = setup();
    const got = await Promise.all(Array.from({ length: 20 }, () => s.tokens.getToken()));
    expect(s.mints()).toBe(1);
    expect(new Set(got.map((t) => t.value))).toEqual(new Set(["tok-1"]));
  });

  it("reuses the cached token, then refreshes 5 min before expires_in", async () => {
    const s = setup(3_600);
    await s.tokens.getToken();
    s.advance((3_600 - 301) * 1000);
    expect((await s.tokens.getToken()).value).toBe("tok-1");
    expect(s.mints()).toBe(1);
    s.advance(2_000); // now 299 s before expiry: inside the 5-minute window
    expect((await s.tokens.getToken()).value).toBe("tok-2");
    expect(s.mints()).toBe(2);
  });

  it("forces exactly one refresh on a 401, then retries the call once", async () => {
    const s = setup();
    const bearers: string[] = [];
    const result = await s.tokens.withToken((bearer) => {
      bearers.push(bearer);
      if (bearers.length === 1) {
        return Promise.reject(new HttpStatusError("paypal", "GET", "u", 401, "{}", {}, undefined));
      }
      return Promise.resolve("ok");
    });
    expect(result).toBe("ok");
    expect(bearers).toEqual(["tok-1", "tok-2"]);
    expect(s.mints()).toBe(2);
  });

  it("does not loop: a second 401 propagates", async () => {
    const s = setup();
    let calls = 0;
    const err = await s.tokens
      .withToken(() => {
        calls += 1;
        return Promise.reject(new HttpStatusError("paypal", "GET", "u", 401, "{}", {}, undefined));
      })
      .catch((e: unknown) => e);
    expect((err as HttpStatusError).status).toBe(401);
    expect(calls).toBe(2);
    expect(s.mints()).toBe(2);
  });

  it("does not refresh on other errors", async () => {
    const s = setup();
    const err = await s.tokens
      .withToken(() => Promise.reject(new HttpStatusError("paypal", "GET", "u", 403, "{}", {}, undefined)))
      .catch((e: unknown) => e);
    expect((err as HttpStatusError).status).toBe(403);
    expect(s.mints()).toBe(1);
  });

  it("caches per client id and exposes scopes", async () => {
    const s = setup();
    const t = await s.tokens.getToken();
    expect([...s.cache.keys()]).toEqual(["cid"]);
    expect(hasScope(t, TRANSACTION_SEARCH_SCOPE)).toBe(true);
    expect(hasScope(t, "missing")).toBe(false);
  });
});
