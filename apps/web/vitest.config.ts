import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // e2e/ is Playwright's (M1-07), never vitest's.
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
    // The db-backed auth tests share one database (caps count across it); run files one at a time.
    fileParallelism: false,
    // M2-05: component tests render next-intl's `Link`, whose ESM build imports `next/navigation` without
    // an extension; inlining it lets Vite resolve that import (Node's ESM resolver refuses it).
    server: { deps: { inline: ["next-intl"] } },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
