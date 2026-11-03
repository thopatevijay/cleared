import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { API_CSP, STATIC_SECURITY_HEADERS } from "./src/lib/security-headers.ts";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser's Sentry DSN (M1-08): the public copy of SENTRY_DSN, fixed at build. Empty → disabled.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env["SENTRY_DSN"] ?? "" },
  // BL-01 6595246110: Bryntum's prebuilt module is loaded at runtime from public/vendor/ (scripts/
  // vendor-bryntum.ts), never bundled; its imports resolve to the loaded engine.
  turbopack: {
    resolveAlias: { "@bryntum/calendar": "./src/components/cash-calendar/bryntum-runtime.ts" },
  },
  // M4-05: HSTS, nosniff, Referrer-Policy and frame denial on every response. Pages get their nonce CSP
  // from proxy.ts; the API and the probes get API_CSP here (never both: two CSPs would stack).
  async headers() {
    const csp = [{ key: "Content-Security-Policy", value: API_CSP }];
    return [
      { source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] },
      { source: "/api/:path*", headers: csp },
      { source: "/healthz", headers: csp },
      { source: "/readyz", headers: csp },
    ];
  },
};

// next-intl (M1-07): messages per locale, loaded by src/i18n/request.ts.
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
