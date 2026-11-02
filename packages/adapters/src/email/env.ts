// The process's email sender from its environment (M3-08: the worker; the web builds its own from its
// validated config): Resend behind the recipient guard, or a sender that refuses when unconfigured.
import { createResendSender } from "./resend.ts";
import { parseAllowlist, unconfiguredSender, withRecipientGuard, type EmailSender } from "./sender.ts";

export function emailSenderFromEnv(env: Readonly<Record<string, string | undefined>>): EmailSender {
  const apiKey = env["RESEND_API_KEY"] ?? "";
  const from = env["EMAIL_FROM"] ?? "";
  if (apiKey === "" || from === "") return unconfiguredSender;
  return withRecipientGuard(
    createResendSender({ apiKey, from }),
    parseAllowlist(env["EMAIL_RECIPIENT_ALLOWLIST"]),
  );
}
