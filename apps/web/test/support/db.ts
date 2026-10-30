// Integration-test support (M1-05): the compose Postgres from DATABASE_URL (export your PORT_OFFSET
// port), a probe that skips db-backed tests when it is unreachable (REQUIRE_DB=1 fails instead, in
// global-setup.ts), and `testDeps` with an injectable clock, config and email sender.
import { randomBytes, randomUUID } from "node:crypto";
import { createDb, databaseUrl, type Db } from "@cleared/db";
import type { EmailSender } from "@cleared/adapters";
import type { AuthConfig } from "../../src/server/config.ts";
import { emailSenderFor, type Deps } from "../../src/server/deps.ts";

export const TEST_DATABASE_URL = databaseUrl();
export const ORIGIN = "http://localhost:3000";

export async function probeDatabase(url: string): Promise<boolean> {
  const db = createDb(url);
  db.$client.on("error", () => undefined);
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("probe timeout"));
      }, 1500),
    );
    await Promise.race([db.$client.query("select 1"), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    await db.$client.end().catch(() => undefined);
  }
}

let shared: Db | undefined;
export function testDb(): Db {
  shared ??= createDb(TEST_DATABASE_URL);
  return shared;
}

export function testConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    appOrigin: ORIGIN,
    sessionSecret: randomBytes(32).toString("base64"),
    resend: { apiKey: "re_test_key", from: "Cleared <onboarding@resend.dev>" },
    emailAllowlist: ["owner@example.test"],
    llmWorkspaceCapUsd: "0.10",
    demoPerIpPerDay: 3,
    demoGlobalMax: 100_000,
    ...overrides,
  };
}

export function testDeps(
  overrides: { config?: Partial<AuthConfig>; now?: () => Date; email?: EmailSender } = {},
): Deps {
  const config = testConfig(overrides.config);
  return {
    db: testDb(),
    config,
    email: overrides.email ?? emailSenderFor(config),
    now: overrides.now ?? (() => new Date()),
  };
}

/** A fresh client IP per test, so per-IP caps never collide across tests or runs. */
export function freshIp(): string {
  const b = randomBytes(3);
  return `10.${String(b[0])}.${String(b[1])}.${String(b[2])}`;
}

export function req(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    origin?: string | null;
    key?: string | null;
    ip?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const method = init.method ?? "POST";
  const headers: Record<string, string> = { ...init.headers };
  if (method !== "GET") {
    headers["content-type"] ??= "application/json";
    if (init.origin !== null) headers["origin"] = init.origin ?? ORIGIN;
    if (init.key !== null) headers["idempotency-key"] = init.key ?? randomUUID();
  }
  if (init.ip !== undefined) headers["x-forwarded-for"] = `203.0.113.9, ${init.ip}`;
  if (init.cookie !== undefined) headers["cookie"] = init.cookie;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** `name=value` of the session cookie in a response, for the next request's Cookie header. */
export function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const pair = set.split(";")[0] ?? "";
  if (!pair.startsWith("__Host-cleared_session=") || pair.endsWith("=")) {
    throw new Error(`no session cookie in response (status ${String(res.status)})`);
  }
  return pair;
}

export const uniqueEmail = (prefix: string): string => `${prefix}-${randomUUID()}@example.test`;
