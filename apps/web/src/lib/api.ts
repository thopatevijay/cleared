// Browser calls to Cleared's API (M1-07): JSON, same origin, an Idempotency-Key on every mutation, and
// the correlation id kept for the "Reference" shown in errors.
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly correlationId: string | null;
  /** seconds, from Retry-After */
  readonly retryAfter: number | null;
}

/** status 0 = network error (offline, DNS, reset). */
export const NETWORK_ERROR = 0;

async function read(res: Response): Promise<ApiResult> {
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    body = null;
  }
  const ra = Number(res.headers.get("retry-after"));
  return {
    status: res.status,
    body,
    correlationId: res.headers.get("x-correlation-id"),
    retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null,
  };
}

export async function postJson(path: string, body: unknown, idempotencyKey: string): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    return await read(res);
  } catch {
    return { status: NETWORK_ERROR, body: null, correlationId: null, retryAfter: null };
  }
}

/** A multipart upload (M2-05 evidence intake); the browser sets the multipart boundary. */
export async function postForm(path: string, form: FormData, idempotencyKey: string): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: form,
      credentials: "same-origin",
    });
    return await read(res);
  } catch {
    return { status: NETWORK_ERROR, body: null, correlationId: null, retryAfter: null };
  }
}

/** The envelope's `error.code` (ADR 0003), or null. */
export function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const e = (body as { error?: { code?: unknown } }).error;
  return typeof e?.code === "string" ? e.code : null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly correlationId: string | null;
  constructor(status: number, correlationId: string | null) {
    super(`api ${String(status)}`);
    this.status = status;
    this.correlationId = correlationId;
  }
}

/** SWR fetcher: the parsed body, or an ApiError carrying the status and correlation id. */
export async function getJson(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(NETWORK_ERROR, null);
  }
  const out = await read(res);
  if (out.status !== 200) throw new ApiError(out.status, out.correlationId);
  return out.body;
}

export function minutesFrom(seconds: number | null): number {
  return Math.max(1, Math.ceil((seconds ?? 60) / 60));
}

export function newKey(): string {
  return crypto.randomUUID();
}
