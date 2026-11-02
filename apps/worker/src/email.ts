// The worker's email dependencies (M3-08): the guarded Resend sender (EMAIL_RECIPIENT_ALLOWLIST) and the
// public origin the links point at. Without RESEND_API_KEY the worker still boots; every send is refused
// and logged, and the in-app notification stays the record.
import { emailSenderFromEnv, type EmailSender } from "@cleared/adapters";

export interface EmailRuntime {
  readonly sender: EmailSender;
  /** APP_BASE_URL: every email links here */
  readonly appBaseUrl: string;
}

export function emailFromEnv(env: NodeJS.ProcessEnv): EmailRuntime {
  return { sender: emailSenderFromEnv(env), appBaseUrl: env["APP_BASE_URL"] ?? "http://localhost:3000" };
}
