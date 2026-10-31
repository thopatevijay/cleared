import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // M2-01: tests may sit next to their module (src/**/*.test.ts) as well as under test/.
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // M1-01 AC: the domain core keeps >= 90% line and branch coverage.
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
