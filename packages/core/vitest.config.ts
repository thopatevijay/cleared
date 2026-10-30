import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // M1-01 AC: the domain core keeps >= 90% line and branch coverage.
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
