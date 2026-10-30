// What the auth handlers need, injected so tests can pass their own clock, database and email sender.
// Route files call `getDeps()`, built lazily on the first request (never at build time).
import { createResendSender, withRecipientGuard, type EmailSender } from "@cleared/adapters";
import { createDb, databaseUrl, type Db } from "@cleared/db";
import { authConfigFromEnv, type AuthConfig } from "./config.ts";

export interface Deps {
  readonly db: Db;
  readonly config: AuthConfig;
  /** Already wrapped in the recipient guard. */
  readonly email: EmailSender;
  readonly now: () => Date;
}

/** A sender for environments with no Resend key: refuses and logs, so sign-in fails closed. */
const unconfiguredSender: EmailSender = {
  send() {
    console.warn(JSON.stringify({ service: "email", msg: "email refused", reason: "resend_not_configured" }));
    return Promise.resolve({ kind: "refused", reason: "not_configured" });
  },
};

export function emailSenderFor(config: AuthConfig): EmailSender {
  if (config.resend === null) return unconfiguredSender;
  return withRecipientGuard(createResendSender(config.resend), config.emailAllowlist);
}

let deps: Deps | undefined;

export function getDeps(): Deps {
  if (deps === undefined) {
    const config = authConfigFromEnv(process.env);
    deps = { db: createDb(databaseUrl()), config, email: emailSenderFor(config), now: () => new Date() };
  }
  return deps;
}
