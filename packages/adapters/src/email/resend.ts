// Resend behind `EmailSender` (ADR 0015 addendum): one `POST /emails` on the shared HTTP client
// (10 s timeout, retries only on timeout/5xx/429, the breaker, the recorder hook). No Resend SDK: it
// calls global fetch with no transport option.
import { z } from "zod";
import { createHttpClient, VENDOR_TIMEOUTS_MS, type Exchange, type HttpClient } from "../http/client.ts";
import type { EmailMessage, EmailSender, SendResult } from "./sender.ts";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

const SendResponse = z.object({ id: z.string().min(1) });

export interface ResendOptions {
  readonly apiKey: string;
  /** `EMAIL_FROM`, e.g. `Cleared <onboarding@resend.dev>` */
  readonly from: string;
  /** Defaults to a client on `createHttpClient({ vendor: "resend", timeoutMs: 10 s })`. */
  readonly http?: HttpClient;
  readonly onExchange?: (exchange: Exchange) => void;
  readonly fetch?: typeof fetch;
}

export function createResendSender(opts: ResendOptions): EmailSender {
  if (opts.apiKey === "") throw new Error("RESEND_API_KEY is empty");
  if (opts.from === "") throw new Error("EMAIL_FROM is empty");
  const http =
    opts.http ??
    createHttpClient({
      vendor: "resend",
      timeoutMs: VENDOR_TIMEOUTS_MS.resend,
      ...(opts.onExchange ? { onExchange: opts.onExchange } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      };
      if (message.idempotencyKey !== undefined) headers["idempotency-key"] = message.idempotencyKey;
      const res = await http.request({
        method: "POST",
        url: RESEND_EMAILS_URL,
        headers,
        body: JSON.stringify({
          from: opts.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        // Safe to repeat only when Resend can dedupe it.
        idempotent: message.idempotencyKey !== undefined,
      });
      const body = SendResponse.parse(JSON.parse(res.bodyText));
      return { kind: "sent", id: body.id };
    },
  };
}
