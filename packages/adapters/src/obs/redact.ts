// Log and error-report redaction (M1-08). Applied to every log line (pino `formatters.log`) and every
// Sentry event (`beforeSend`), at any depth, so a secret or personal value never reaches Render logs
// or Sentry whatever shape the logged object has:
// - credentials and personal fields are replaced by `[Redacted]` (matched by key name, any nesting)
// - `raw` (a webhook body) is replaced by its size and sha256, so it can still be matched to the row
// - email addresses inside any string are replaced by `[email]`
import { createHash } from "node:crypto";

export const REDACTED = "[Redacted]";
export const EMAIL_REDACTED = "[email]";

/**
 * Key names (lower-cased, `-`/`_` removed) whose value is never logged. `payer` covers `payer.*`;
 * `token` covers `*.token`, `access_token` and `accessToken` style keys via the suffix rule below.
 */
const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "token",
  "email",
  "emailaddress",
  "clientsecret",
  "secret",
  "password",
  "payer",
  "apikey",
]);

/** Suffixes that mark a secret whatever the prefix (`accessToken`, `refresh_token`, `sessionSecret`). */
const SECRET_SUFFIXES = ["token", "secret", "password", "email"];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_DEPTH = 10;

function normalise(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function isSecretKey(key: string): boolean {
  const k = normalise(key);
  return SECRET_KEYS.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

/** A raw body as it may be logged: its byte size and sha256, never its content. */
export function rawBodySummary(raw: unknown): { size: number; sha256: string } {
  const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? raw : JSON.stringify(raw);
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function scrubString(value: string): string {
  return value.replace(EMAIL, EMAIL_REDACTED);
}

/** A deep copy of `value` with secrets, personal fields, raw bodies and emails removed. */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return walkError(value, depth, seen);
  if (Array.isArray(value)) return value.map((v: unknown) => walk(v, depth + 1, seen));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "raw") out[key] = v === undefined || v === null ? v : rawBodySummary(v);
    else if (isSecretKey(key)) out[key] = REDACTED;
    else out[key] = walk(v, depth + 1, seen);
  }
  return out;
}

function walkError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const extra = walk({ ...error }, depth + 1, seen) as Record<string, unknown>;
  return {
    ...extra,
    type: error.name,
    message: scrubString(error.message),
    ...(error.stack === undefined ? {} : { stack: scrubString(error.stack) }),
  };
}
