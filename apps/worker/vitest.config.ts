import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration test files share one database and pg-boss schema; run them one file at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
