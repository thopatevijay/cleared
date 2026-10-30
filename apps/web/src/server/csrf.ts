// CSRF for mutating routes (ADR 0003, M1-05): `Content-Type: application/json` (a cross-site form
// cannot send it without a CORS preflight), an `Origin` equal to APP_BASE_URL's origin, and an
// `Idempotency-Key` header.
import { apiError, correlationId } from "./respond.ts";

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type MutationCheck =
  | { readonly ok: true; readonly idempotencyKey: string }
  | { readonly ok: false; readonly response: Response };

export function checkMutation(req: Request, appOrigin: string): MutationCheck {
  const cid = correlationId(req);
  const fail = (status: number, code: string, message: string): MutationCheck => ({
    ok: false,
    response: apiError(status, code, message, cid),
  });
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return fail(415, "unsupported_media_type", "Send the request as application/json.");
  }
  if (req.headers.get("origin") !== appOrigin) {
    return fail(403, "forbidden_origin", "This request did not come from Cleared.");
  }
  const key = req.headers.get("idempotency-key");
  if (key === null || !KEY_RE.test(key)) {
    return fail(400, "idempotency_key_required", "An Idempotency-Key header is required.");
  }
  return { ok: true, idempotencyKey: key };
}

/** Reads a JSON body; an empty body is `{}`. Returns undefined when the body is not valid JSON. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
