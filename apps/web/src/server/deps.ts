// What the auth handlers need, injected so tests can pass their own clock, database and email sender.
// Route files call `getDeps()`, built lazily on the first request (never at build time).
import {
  createResendSender,
  unconfiguredSender,
  withRecipientGuard,
  type EmailSender,
} from "@cleared/adapters";
import { createDb, databaseUrl, type Db } from "@cleared/db";
import { authConfigFromEnv, type AuthConfig } from "./config.ts";

export interface Deps {
  readonly db: Db;
  readonly config: AuthConfig;
  /** Already wrapped in the recipient guard. */
  readonly email: EmailSender;
  readonly now: () => Date;
}

/** No Resend key: `unconfiguredSender` refuses and logs, so sign-in fails closed. */
export function emailSenderFor(config: AuthConfig): EmailSender {
  if (config.resend === null) return unconfiguredSender;
  return withRecipientGuard(createResendSender(config.resend), config.emailAllowlist);
}

let deps: Deps | undefined;
let db: Db | undefined;

/** The web process's one pool; `/readyz` uses it without needing the auth config (M1-08). */
export function getDb(): Db {
  db ??= createDb(databaseUrl());
  return db;
}

export function getDeps(): Deps {
  if (deps === undefined) {
    const config = authConfigFromEnv(process.env);
    deps = { db: getDb(), config, email: emailSenderFor(config), now: () => new Date() };
  }
  return deps;
}
