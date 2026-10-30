import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser's Sentry DSN (M1-08): the public copy of SENTRY_DSN, fixed at build. Empty → disabled.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env["SENTRY_DSN"] ?? "" },
};

export default config;
