// Server configuration for auth (M1-05), parsed from the environment once, with zod. Values are never
// logged. Tests build an `AuthConfig` directly.
import { z } from "zod";
import { parseAllowlist } from "@cleared/adapters";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_RECIPIENT_ALLOWLIST: z.string().optional(),
  LLM_WORKSPACE_CAP_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default("0.10"),
  DEMO_WORKSPACES_PER_IP_PER_DAY: z.coerce.number().int().min(0).default(3),
  DEMO_WORKSPACES_GLOBAL_MAX: z.coerce.number().int().min(0).default(200),
});

export interface AuthConfig {
  /** Origin of the app, e.g. `https://cleared-web-gd1b.onrender.com`; mutating requests must match it. */
  readonly appOrigin: string;
  readonly sessionSecret: string;
  readonly resend: { readonly apiKey: string; readonly from: string } | null;
  readonly emailAllowlist: readonly string[] | null;
  /** numeric string, e.g. "0.10" (ADR 0007) */
  readonly llmWorkspaceCapUsd: string;
  readonly demoPerIpPerDay: number;
  readonly demoGlobalMax: number;
}

export function authConfigFromEnv(env: Readonly<Record<string, string | undefined>>): AuthConfig {
  const e = Env.parse(env);
  const apiKey = e.RESEND_API_KEY ?? "";
  const from = e.EMAIL_FROM ?? "";
  return {
    appOrigin: new URL(e.APP_BASE_URL).origin,
    sessionSecret: e.SESSION_SECRET,
    resend: apiKey !== "" && from !== "" ? { apiKey, from } : null,
    emailAllowlist: parseAllowlist(e.EMAIL_RECIPIENT_ALLOWLIST),
    llmWorkspaceCapUsd: e.LLM_WORKSPACE_CAP_USD,
    demoPerIpPerDay: e.DEMO_WORKSPACES_PER_IP_PER_DAY,
    demoGlobalMax: e.DEMO_WORKSPACES_GLOBAL_MAX,
  };
}
