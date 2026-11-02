// Next 16 proxy (M1-07): locale routing (next-intl: `/` → `/en`, `/payments` → `/en/payments`), and a
// signed-in-only area: without a session cookie, `/<locale>/payments` and `/<locale>/audit` redirect to
// the landing page. The cookie's validity is checked against the database by the page itself (the proxy
// never touches the database). Lives here, not in src/: the app dir is `apps/web/app` (BL-01 6528458469).
// M3-06: the public acknowledgement page `/<locale>/ack/<token>` gets a strict per-request nonce CSP
// (Next reads the nonce from the request's CSP header and puts it on its own scripts), `noindex`,
// `no-referrer` (the token is in the URL) and `no-store`.
import { NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./src/i18n/routing.ts";
import { SESSION_COOKIE } from "./src/lib/session-cookie.ts";

const intl = createMiddleware(routing);
const PROTECTED = /^\/(en|hi)\/(payments|audit|disputes|notifications)(\/|$)/;
const ACK_PAGE = /^\/(en|hi)\/ack\/[^/]+\/?$/;

export function ackCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

function ackPage(req: NextRequest): Response {
  const nonce = btoa(crypto.randomUUID());
  const csp = ackCsp(nonce);
  const headers = new Headers(req.headers);
  headers.set("content-security-policy", csp);
  // next-intl forwards the request's headers (plus its locale header) to the page, CSP included.
  const res = intl(new NextRequest(req, { headers }));
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-robots-tag", "noindex, nofollow");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

export default function proxy(req: NextRequest): Response {
  const m = PROTECTED.exec(req.nextUrl.pathname);
  if (m !== null && !req.cookies.has(SESSION_COOKIE)) {
    const to = req.nextUrl.clone();
    to.pathname = `/${m[1] ?? routing.defaultLocale}`;
    to.search = "";
    return NextResponse.redirect(to, 307);
  }
  if (ACK_PAGE.test(req.nextUrl.pathname)) return ackPage(req);
  const res = intl(req);
  // `/ack/<token>` redirects to the visitor's locale: that response must not leak the token either.
  if (req.nextUrl.pathname.startsWith("/ack/")) res.headers.set("referrer-policy", "no-referrer");
  return res;
}

export const config = {
  // Pages only: never the API, health checks, Next internals or files with an extension.
  matcher: ["/((?!api|healthz|readyz|_next|_vercel|monitoring|.*\\..*).*)"],
};
