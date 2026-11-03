// Flat config shared by every workspace package (each runs `eslint .` from its own directory).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// ESLint 10 core rule selectors (eslint-plugin-react 7.37.5 has no ESLint 10 support: M4-03 ticket).
const JSX_TEXT = {
  selector: "JSXText[value=/\\S/]",
  message: "User-visible text comes from apps/web/messages (en.json, hi.json). Codes: {\"CODE\"} (M4-03).",
};
const MONEY_FORMAT = [
  {
    selector: "CallExpression[callee.property.name=/^(toFixed|toLocaleString)$/]",
    message: "Format amounts and times with core's formatMoney / formatDateTime (Intl from the string) (M4-03).",
  },
];

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
  // M4-03: user-visible text comes from apps/web/messages (en, hi), never a JSX literal; amounts and times
  // go through core's formatMoney / formatDateTime (PayPal's decimal string, never a float). One
  // `no-restricted-syntax` entry per file set: a later block's entry replaces an earlier one's.
  {
    files: ["apps/web/app/**/*.tsx", "apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: { "no-restricted-syntax": ["error", JSX_TEXT, ...MONEY_FORMAT] },
  },
  {
    files: [
      "apps/web/app/**/*.ts",
      "apps/web/src/**/*.ts",
      "packages/core/src/notifications/**/*.ts",
      "packages/adapters/src/pdf/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": ["error", ...MONEY_FORMAT] },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
