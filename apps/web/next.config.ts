import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

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
};

// next-intl (M1-07): messages per locale, loaded by src/i18n/request.ts.
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
