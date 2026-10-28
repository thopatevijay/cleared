// Vitest 5 replaces the workspace file with `test.projects`: one project per workspace package.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
