// The email port (ADR 0015): one `EmailSender` for magic links (M1-05) and alerts (M3-08), and the
// recipient guard every sender is wrapped in while `EMAIL_RECIPIENT_ALLOWLIST` is set.
import { z } from "zod";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Sent as the vendor's idempotency key, so a retried send is delivered once. */
  readonly idempotencyKey?: string;
}

export type SendResult =
  | { readonly kind: "sent"; readonly id: string }
  | { readonly kind: "refused"; readonly reason: "recipient_not_allowlisted" };

export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>;
}

/** A structured log line; the address itself is never logged, only its domain. */
export interface EmailLogEvent {
  readonly msg: string;
  readonly reason?: string;
  readonly recipientDomain?: string;
  readonly emailId?: string;
}
export type EmailLog = (event: EmailLogEvent) => void;

const defaultLog: EmailLog = (event) => {
  console.warn(JSON.stringify({ service: "email", ...event }));
};

const EmailAddress = z.email();

/**
 * `EMAIL_RECIPIENT_ALLOWLIST` (comma-separated) as lower-cased addresses, or null when unset/empty
 * (no guard). An entry that is not an email address throws: a typo must not open the guard.
 */
export function parseAllowlist(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const entries = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  for (const entry of entries) {
    if (!EmailAddress.safeParse(entry).success) {
      throw new Error("EMAIL_RECIPIENT_ALLOWLIST has an entry that is not an email address");
    }
  }
  return entries;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Sends only to allowlisted recipients when `allowlist` is non-null; anything else is refused before
 * the inner sender runs (no vendor request), with a logged reason.
 */
export function withRecipientGuard(
  inner: EmailSender,
  allowlist: readonly string[] | null,
  log: EmailLog = defaultLog,
): EmailSender {
  if (allowlist === null) return inner;
  const allowed = new Set(allowlist.map((a) => a.toLowerCase()));
  return {
    async send(message) {
      if (!allowed.has(message.to.trim().toLowerCase())) {
        log({
          msg: "email refused",
          reason: "recipient_not_allowlisted",
          recipientDomain: domainOf(message.to),
        });
        return { kind: "refused", reason: "recipient_not_allowlisted" };
      }
      return inner.send(message);
    },
  };
}
