// `notification.send_email` (M3-08, ADR 0015): email one notification to the workspace's seller.
// - Demo workspaces (no user email) are in-app only: `email_status = no_recipient`, no request.
// - The sender is wrapped in the recipient guard (EMAIL_RECIPIENT_ALLOWLIST): a refused recipient gets no
//   Resend request; the refusal is logged and recorded (`refused`), never an error.
// - Rendered at send time in the workspace's locale and time zone, so a late send states the true time left.
// - Resend dedupes on `Idempotency-Key = notification id`, so a retry never sends twice.
// - A failed send throws: pg-boss retries with backoff, then the DLQ (Sentry, boss.ts). Before the last
//   attempt throws, the row is marked `failed` outside the delivery's transaction, so the centre can say
//   "Email not sent"; the in-app notification itself was committed long before.
import type { Logger } from "@cleared/adapters";
import { fromEpochMs, renderNotification, storedNotification, type WorkspaceId } from "@cleared/core";
import { forWorkspace, platform, type Db } from "@cleared/db";
import { z } from "zod";
import type { Handler } from "../consume.ts";
import type { EmailRuntime } from "../email.ts";

export interface SendEmailDeps {
  readonly db: Db;
  readonly email: EmailRuntime;
  readonly now: () => Date;
}

const SendEmailInput = z.object({ notificationId: z.uuid(), workspaceId: z.uuid() });

export type SendEmailOutcome = "sent" | "refused" | "no_recipient" | "already_sent" | "not_found";

export function sendEmailHandler(deps: SendEmailDeps): Handler {
  return async (data, ctx) => {
    const input = SendEmailInput.parse(data);
    const ws = input.workspaceId as WorkspaceId;
    try {
      const outcome = await sendNotificationEmail(deps, ws, input.notificationId, ctx);
      ctx.log.info({ notificationId: input.notificationId, outcome }, "notification email");
    } catch (error) {
      if (ctx.job.retryCount >= ctx.job.retryLimit) {
        await forWorkspace(deps.db, ws).notifications.recordEmail(input.notificationId, {
          status: "failed",
          at: deps.now(),
        });
      }
      throw error;
    }
  };
}

async function sendNotificationEmail(
  deps: SendEmailDeps,
  ws: WorkspaceId,
  notificationId: string,
  ctx: { tx: Parameters<Handler>[1]["tx"]; log: Logger },
): Promise<SendEmailOutcome> {
  const repos = forWorkspace(deps.db, ws);
  const n = await repos.notifications.get(notificationId, ctx.tx);
  const input = n === null ? null : storedNotification(n);
  if (n === null || input === null) return "not_found";
  if (n.emailStatus === "sent") return "already_sent";
  const at = deps.now();
  const [user] = await repos.users.list({ limit: 1, tx: ctx.tx });
  const workspace = await platform(deps.db).workspaces.get(ws, ctx.tx);
  if (user === undefined || workspace === null) {
    await repos.notifications.recordEmail(n.id, { status: "no_recipient", at }, ctx.tx);
    return "no_recipient";
  }
  const rendered = renderNotification(input, {
    locale: workspace.locale,
    timeZone: workspace.timezone,
    appBaseUrl: deps.email.appBaseUrl,
    now: fromEpochMs(at.getTime()),
  });
  const result = await deps.email.sender.send({
    to: user.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    idempotencyKey: `notification-${n.id}`,
  });
  if (result.kind === "refused") {
    ctx.log.info({ notificationId: n.id, reason: result.reason }, "notification email refused");
    await repos.notifications.recordEmail(n.id, { status: "refused", at }, ctx.tx);
    return "refused";
  }
  ctx.log.info({ notificationId: n.id, emailId: result.id }, "notification email sent");
  await repos.notifications.recordEmail(n.id, { status: "sent", emailId: result.id, at }, ctx.tx);
  return "sent";
}
