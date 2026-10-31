// Playwright (M1-07). Two modes:
//   local    (no E2E_BASE_URL): starts `next start` and the worker against the compose Postgres
//            (DATABASE_URL; `PORT_OFFSET=100 make up` → 5532), each with the msw PayPal stub preloaded
//            (e2e/support/paypal-stub.ts). Run `pnpm --filter @cleared/web build` first.
//   deployed (E2E_BASE_URL=<render url>): no local servers; the real sandbox and PayPal's webhook.
//   live     (E2E_LIVE=1, M2-10): local servers WITHOUT the stub, on the real sandbox. The PayPal
//            credentials are inherited from the environment (the main checkout's .env loaded by path,
//            WORKFLOW.md "Live lines"); nothing here names them.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// An empty E2E_BASE_URL (as in .env.example, inherited by live runs) means local, not deployed.
const deployed = process.env["E2E_BASE_URL"] === "" ? undefined : process.env["E2E_BASE_URL"];
const port = Number(process.env["E2E_PORT"] ?? 3100);
const local = `http://localhost:${String(port)}`;
const stub = fileURLToPath(new URL("./e2e/support/paypal-stub.ts", import.meta.url));
const databaseUrl = process.env["DATABASE_URL"] ?? "postgres://cleared:cleared@localhost:5532/cleared";
const live = process.env["E2E_LIVE"] === "1";
const preload = live ? "" : `--import ${stub}`;

// Local-only values: dummy PayPal credentials (the stub answers every PayPal call) and a run secret.
const shared = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "production",
  PAYPAL_ENV: "sandbox",
  ...(live ? {} : { PAYPAL_CLIENT_ID: "e2e-local-client", PAYPAL_CLIENT_SECRET: "e2e-local-secret" }),
  // info: the worker's readiness line ("worker ready") is what Playwright waits for.
  LOG_LEVEL: "info",
  E2E_WEB_URL: local,
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: deployed ?? local,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  webServer: deployed
    ? []
    : [
        {
          command: `node_modules/.bin/next start -p ${String(port)}`,
          url: `${local}/healthz`,
          reuseExistingServer: false,
          stdout: "pipe",
          env: {
            ...shared,
            NODE_OPTIONS: preload,
            E2E_PAYPAL_STUB: live ? "" : "web",
            APP_BASE_URL: local,
            SESSION_SECRET: randomBytes(32).toString("base64"),
            PAYPAL_WEBHOOK_ID: "WH-E2E-LOCAL",
            LLM_WORKSPACE_CAP_USD: "0.10",
            DEMO_WORKSPACES_PER_IP_PER_DAY: "10000",
            DEMO_WORKSPACES_GLOBAL_MAX: "100000",
          },
        },
        {
          command: `node ${preload} ../worker/src/index.ts`,
          wait: { stdout: /"msg":"worker ready"/ },
          reuseExistingServer: false,
          stdout: "pipe",
          env: {
            ...shared,
            E2E_PAYPAL_STUB: live ? "" : "worker",
            // M2-05: locally the AI steps replay recorded OpenAI responses (e2e/support/openai-stub.ts); a
            // dummy key selects the real provider, whose calls the stub answers. Live runs inherit theirs.
            ...(live
              ? {}
              : {
                  OPENAI_API_KEY: "e2e-local-openai",
                  LLM_DAILY_CAP_USD: "5",
                  LLM_WORKSPACE_CAP_USD: "0.10",
                }),
          },
        },
      ],
});
