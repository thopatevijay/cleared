// Next 16 proxy (M1-07): locale routing (next-intl: `/` → `/en`, `/payments` → `/en/payments`), and a
// signed-in-only area: without a session cookie, `/<locale>/payments` and `/<locale>/audit` redirect to
// the landing page. The cookie's validity is checked against the database by the page itself (the proxy
// never touches the database). Lives here, not in src/: the app dir is `apps/web/app` (BL-01 6528458469).
import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./src/i18n/routing.ts";
import { SESSION_COOKIE } from "./src/lib/session-cookie.ts";

const intl = createMiddleware(routing);
const PROTECTED = /^\/(en|hi)\/(payments|audit)(\/|$)/;

export default function proxy(req: NextRequest): Response {
  const m = PROTECTED.exec(req.nextUrl.pathname);
  if (m !== null && !req.cookies.has(SESSION_COOKIE)) {
    const to = req.nextUrl.clone();
    to.pathname = `/${m[1] ?? routing.defaultLocale}`;
    to.search = "";
    return NextResponse.redirect(to, 307);
  }
  return intl(req);
}

export const config = {
  // Pages only: never the API, health checks, Next internals or files with an extension.
  matcher: ["/((?!api|healthz|readyz|_next|_vercel|monitoring|.*\\..*).*)"],
};
