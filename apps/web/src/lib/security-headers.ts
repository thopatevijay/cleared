// Security response headers (M4-05, docs/security/threat-model.md). Pure: used by proxy.ts (the per-request
// nonce CSP on pages) and next.config.ts (the static set on every response, API included).
//
// Page CSP: scripts need the request's nonce (Next puts it on its own inline scripts) or come from our
// origin (Next's chunks, Bryntum's `/vendor/` module). There is no 'strict-dynamic' here on purpose:
// Bryntum's trial bundle injects Google Tag Manager on some hosts (BL-01 6491378837), and
// 'strict-dynamic' would trust a script that a trusted script inserts. Without it, a host outside
// 'self' is refused, and `connect-src` refuses `bryntum.com/verify`. No 'unsafe-eval' outside `next dev`
// (React's dev build needs it), which also stops Bryntum's fetched `new Function(...)` path.
// Styles allow 'unsafe-inline': React `style` props and Bryntum's runtime styles need it (a residual
// risk in the threat model, not a script-execution path).

/** The CSP of every page except the public acknowledgement page (which keeps its stricter one). */
export function pageCsp(nonce: string, o: { dev: boolean; reportOrigin: string | null }): string {
  const connect = ["'self'", ...(o.reportOrigin === null ? [] : [o.reportOrigin])];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${o.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}${o.dev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The CSP of non-HTML responses (API JSON, files, probes): nothing may run or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Sent on every response (next.config.ts `headers()`). HSTS is ignored by browsers over plain http. */
export const STATIC_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** Sentry's ingest origin from a DSN (`https://<key>@o1.ingest.sentry.io/2` → `https://o1.ingest.sentry.io`). */
export function reportOriginFromDsn(dsn: string | undefined): string | null {
  if (dsn === undefined || dsn.trim() === "") return null;
  try {
    const u = new URL(dsn);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A fresh base64 nonce (128 bits from a UUIDv4's randomness). */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
