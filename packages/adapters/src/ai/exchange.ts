// TEMPORARY (M0-07): a minimal exchange recorder and scrubber for the OpenAI spike and its replay
// tests. M0-04 owns the real ones (`src/http/client.ts` onExchange, `src/testing/{record,scrub,
// replay}.ts`); replace this file with those when M0-04 lands. The fixture format is M0-04's:
// {meta:{recorded_at, env, ticket, scrubbed:true}, request:{method,url,headers,body}, response:{status,headers,body}}

export interface Exchange {
  readonly request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  readonly response: { status: number; headers: Record<string, string>; body: unknown };
}

export interface Fixture extends Exchange {
  readonly meta: { recorded_at: string; env: string; ticket: string; scrubbed: true; note?: string };
}

export type ExchangeListener = (exchange: Exchange) => void;

/** Header allow-lists: everything else (Authorization, openai-organization, openai-project, cookies) is dropped. */
const REQUEST_HEADERS = new Set(["content-type", "accept"]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "x-request-id",
  "openai-processing-ms",
  "openai-version",
  "retry-after",
]);

function pickHeaders(headers: Headers, allow: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (allow.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  });
  return out;
}

const DATA_URL = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Replaces inline base64 payloads (images, PDFs) with a short marker so fixtures stay small. */
export function elideDataUrls(value: unknown): unknown {
  if (typeof value === "string") {
    const m = DATA_URL.exec(value);
    return m ? `data:${m[1] ?? ""};base64,<elided ${String(m[2]?.length ?? 0)} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(elideDataUrls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elideDataUrls(v)]));
  }
  return value;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requestBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? elideDataUrls(parseBody(init.body)) : null;
}

/**
 * A fetch that reports every exchange, already scrubbed, to `listener`. A transport failure
 * (timeout, connection reset) is reported with status 0 and the error name, then rethrown.
 */
export function recordingFetch(listener: ExchangeListener, inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const request = {
      method,
      url,
      headers: pickHeaders(new Headers(init?.headers), REQUEST_HEADERS),
      body: requestBody(init),
    };
    try {
      const res = await inner(input, init);
      const text = await res.clone().text();
      listener({
        request,
        response: {
          status: res.status,
          headers: pickHeaders(res.headers, RESPONSE_HEADERS),
          body: parseBody(text),
        },
      });
      return res;
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      listener({ request, response: { status: 0, headers: {}, body: { transport_error: name } } });
      throw err;
    }
  };
}

/** A fetch that answers from one recorded fixture; a transport-error fixture throws instead. */
export function replayFetch(fixture: Exchange): typeof fetch {
  return () => {
    const { status, headers, body } = fixture.response;
    if (status === 0) return Promise.reject(new DOMException("replayed transport error", "TimeoutError"));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
}
