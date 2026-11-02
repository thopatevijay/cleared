// Renders one notification for the in-app centre and for email: plain text + simple HTML, no images and
// no tracking pixels, a single link to APP_BASE_URL. The data carries only amounts, reason codes and dates
// (NotificationDataSchema), so evidence text and buyer messages can never reach a template.
import type { Locale } from "../../accounts/workspace.ts";
import {
  notificationPath,
  type NotificationData,
  type NotificationKind,
  type NotificationRefType,
} from "../rules.ts";
import type { Instant } from "../../time.ts";
import { EN } from "./en.ts";
import { escapeHtml, formatAmount, reasonWords, remaining, zonedDate } from "./format.ts";
import { HI } from "./hi.ts";
import type { RenderedNotification, SentenceParams } from "./types.ts";

export interface RenderInput {
  readonly kind: NotificationKind;
  readonly refType: NotificationRefType;
  readonly refId: string;
  readonly data: NotificationData;
}

export interface RenderContext {
  readonly locale: Locale;
  /** the workspace's IANA zone */
  readonly timeZone: string;
  /** APP_BASE_URL, no trailing slash needed */
  readonly appBaseUrl: string;
  /** the remaining time is computed at render time (a late send states the true value) */
  readonly now: Instant;
}

export function sentenceParams(n: RenderInput, ctx: RenderContext): SentenceParams {
  const d = n.data;
  return {
    amount: formatAmount(d.amount, ctx.locale),
    reason: reasonWords(d.reason),
    reasonCode: d.reason ?? "",
    remaining: d.dueDate === null ? null : remaining(d.dueDate, ctx.now),
    due: d.dueDate === null ? null : zonedDate(d.dueDate, ctx.locale, ctx.timeZone),
    release: d.releaseDate === null ? null : zonedDate(d.releaseDate, ctx.locale, ctx.timeZone),
  };
}

export function renderNotification(n: RenderInput, ctx: RenderContext): RenderedNotification {
  const strings = ctx.locale === "hi" ? HI : EN;
  const sentence = strings.sentence(n.kind, sentenceParams(n, ctx));
  const url = `${ctx.appBaseUrl.replace(/\/+$/, "")}/${ctx.locale}${notificationPath(n)}`;
  const text = `${sentence}\n\n${strings.open}: ${url}\n\n${strings.footer}\n`;
  const html =
    `<p>${escapeHtml(sentence)}</p>` +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(strings.open)}</a></p>` +
    `<p style="color:#555;font-size:12px">${escapeHtml(strings.footer)}</p>`;
  return { sentence, subject: sentence, text, html, url };
}
