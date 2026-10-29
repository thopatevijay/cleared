// One PayPal OAuth token provider (ADR 0011): cached per client id, single-flight, refreshed 5 min
// before `expires_in`, one forced refresh on a 401. Scopes are exposed so a missing feature scope
// (Transaction Search) is detected instead of surfacing as a 403 deep in a job.
import { HttpStatusError } from "../http/errors.ts";
import type { HttpClient } from "../http/client.ts";
import { TokenResponseSchema } from "./schemas.ts";

export interface PayPalCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly appId: string | undefined;
}

interface CacheEntry {
  token?: AccessToken;
  inflight?: Promise<AccessToken>;
}

/** Shared across providers in one process, keyed by client id: PayPal penalises re-minting. */
export type TokenCache = Map<string, CacheEntry>;
const processCache: TokenCache = new Map();

export interface TokenProviderOptions {
  readonly http: HttpClient;
  readonly baseUrl: string;
  readonly credentials: PayPalCredentials;
  /** Refresh this long before expiry (default 5 min). */
  readonly refreshSkewMs?: number;
  readonly now?: () => number;
  readonly cache?: TokenCache;
}

export interface TokenProvider {
  getToken(): Promise<AccessToken>;
  /** Drops the cached token if it is still `value` (another caller may have refreshed already). */
  invalidate(value: string): void;
  /** Runs `call` with a bearer token; on a 401, refreshes once and runs it once more. */
  withToken<T>(call: (bearer: string) => Promise<T>): Promise<T>;
}

export const TRANSACTION_SEARCH_SCOPE = "https://uri.paypal.com/services/reporting/search/read";

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const skew = options.refreshSkewMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? processCache;
  const key = options.credentials.clientId;

  function entry(): CacheEntry {
    let e = cache.get(key);
    if (e === undefined) {
      e = {};
      cache.set(key, e);
    }
    return e;
  }

  async function mint(): Promise<AccessToken> {
    const { clientId, clientSecret } = options.credentials;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await options.http.request({
      method: "POST",
      url: `${options.baseUrl}/v1/oauth2/token`,
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
      idempotent: true,
    });
    const parsed = TokenResponseSchema.parse(JSON.parse(res.bodyText));
    return {
      value: parsed.access_token,
      expiresAt: now() + parsed.expires_in * 1000,
      scopes: parsed.scope.split(" ").filter((s) => s !== ""),
      appId: parsed.app_id,
    };
  }

  function getToken(): Promise<AccessToken> {
    const e = entry();
    if (e.token !== undefined && now() < e.token.expiresAt - skew) return Promise.resolve(e.token);
    if (e.inflight !== undefined) return e.inflight;
    const p = mint().then(
      (t) => {
        e.token = t;
        delete e.inflight;
        return t;
      },
      (err: unknown) => {
        delete e.inflight;
        throw err;
      },
    );
    e.inflight = p;
    return p;
  }

  function invalidate(value: string): void {
    const e = entry();
    if (e.token?.value === value) delete e.token;
  }

  async function withToken<T>(call: (bearer: string) => Promise<T>): Promise<T> {
    const first = await getToken();
    try {
      return await call(first.value);
    } catch (err) {
      if (!(err instanceof HttpStatusError) || err.status !== 401) throw err;
      invalidate(first.value);
      const fresh = await getToken();
      return call(fresh.value);
    }
  }

  return { getToken, invalidate, withToken };
}

export function hasScope(token: AccessToken, scope: string): boolean {
  return token.scopes.includes(scope);
}
