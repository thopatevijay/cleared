// Shared template shapes.
import type { NotificationKind } from "../rules.ts";
import type { Remaining, ZonedDate } from "./format.ts";

export interface SentenceParams {
  /** formatted, e.g. `$120.00 USD` */
  readonly amount: string;
  /** the reason in words (disputes) */
  readonly reason: string;
  /** the raw reason code (holds show PayPal's code, e.g. PENDING_REVIEW) */
  readonly reasonCode: string;
  readonly remaining: Remaining | null;
  readonly due: ZonedDate | null;
  readonly release: ZonedDate | null;
}

export interface TemplateStrings {
  sentence(kind: NotificationKind, p: SentenceParams): string;
  readonly open: string;
  readonly footer: string;
}

export interface RenderedNotification {
  /** the in-app line and the email subject */
  readonly sentence: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** absolute link into the app (APP_BASE_URL + locale + path) */
  readonly url: string;
}
