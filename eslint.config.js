// Flat config shared by every workspace package (each runs `eslint .` from its own directory).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "apps/web/public/vendor/**", // Bryntum's prebuilt engine, copied at build (BL-01 6595246110)
      "spikes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": true, "ts-nocheck": true }],
    },
  },
  {
    // M1-02: apps reach the database only through `@cleared/db` repositories (every query scoped by
    // workspace_id), never through Drizzle or the schema directly.
    files: ["apps/**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "drizzle-orm", message: "Use the @cleared/db repositories (M1-02)." },
            { name: "pg", message: "Use the @cleared/db repositories (M1-02)." },
          ],
          patterns: [
            { group: ["drizzle-orm/*"], message: "Use the @cleared/db repositories (M1-02)." },
            {
              group: ["@cleared/db/*", "**/packages/db/**", "**/db/schema", "**/db/schema/**"],
              message: "Import only the @cleared/db entry point (M1-02).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
