// M3-08 AC 5 (live): one T-24 email through the real Resend API to the first EMAIL_RECIPIENT_ALLOWLIST
// address, by the production path (deadline alert row → `notification.send_email` handler with the
// worker's own `emailFromEnv`). Skips without RESEND_API_KEY / EMAIL_FROM / EMAIL_RECIPIENT_ALLOWLIST (CI).
// Prints only Resend's message id, never the address.
import { randomUUID } from "node:crypto";
import { createLogger, parseAllowlist } from "@cleared/adapters";
import { deadlineAlert, WorkspaceIdSchema, type Instant } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { consumeOne } from "../consume.ts";
import { notify } from "../consumers/notifications.ts";
import { emailFromEnv } from "../email.ts";
import { sendEmailHandler } from "./send-email.ts";

const recipient = parseAllowlist(process.env["EMAIL_RECIPIENT_ALLOWLIST"])?.[0];
const configured =
  (process.env["RESEND_API_KEY"] ?? "") !== "" && (process.env["EMAIL_FROM"] ?? "") !== "" && !!recipient;

describe.skipIf(!configured || !dbAvailable)("notification.send_email (live Resend)", () => {
  const db = createDb(url);
  let boss: Queue | undefined;
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await closeDb(db);
  });

  it("sends one T-24 alert to the allowlisted seller and records Resend's id", async () => {
    boss = await createQueue(db, { background: false, max: 2 });
    const email = recipient ?? "";
    const existing = await platform(db).identity.userByEmail(email);
    const wsId =
      existing?.workspaceId ??
      (
        await platform(db).workspaces.create({
          kind: "seller",
          locale: "en",
          timezone: "Asia/Kolkata",
          baseCurrency: "USD",
        })
      ).id;
    const repos = forWorkspace(db, WorkspaceIdSchema.parse(wsId));
    if (existing === null) await repos.users.insert({ email });
    const now = new Date();
    const due = new Date(now.getTime() + 18 * 3_600_000 + 600_000);
    const d = await repos.disputes.insert({
      disputeId: `PP-R-LIVE-${randomUUID().slice(0, 8).toUpperCase()}`,
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amount: "120.00",
      currency: "USD",
      sellerResponseDueDate: due,
    });
    const draft = deadlineAlert({
      disputeRowId: d.id,
      dueDate: due.toISOString() as Instant,
      open: true,
      now: now.toISOString() as Instant,
      amount: { amount: "120.00", currency: "USD" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    });
    expect(draft?.kind).toBe("deadline_t24");
    if (draft === null) return;
    const q = boss;
    const row = await withTransaction(db, (tx) =>
      notify({ db, publisher: createPublisher(db, q) }, tx, repos.workspaceId, draft),
    );
    if (row === null) throw new Error("no notification");
    const log = createLogger({ service: "worker-live", level: "silent" });
    const handler = sendEmailHandler({ db, email: emailFromEnv(process.env), now: () => new Date() });
    const envelope = {
      messageId: randomUUID(),
      correlationId: randomUUID(),
      data: { notificationId: row.id, workspaceId: wsId },
    };
    const job = {
      id: randomUUID(),
      retryCount: 0,
      retryLimit: 5,
      data: envelope,
    } as JobWithMetadata<unknown>;
    await consumeOne({ db, log, now: () => new Date() }, "notification.send_email", handler, job);
    const after = await repos.notifications.get(row.id);
    expect(after).toMatchObject({ emailStatus: "sent", sentVia: "email" });
    expect(after?.emailId).toMatch(/^[0-9a-f-]{36}$/);
    console.log(`RESEND_MESSAGE_ID=${after?.emailId ?? ""}`);
  }, 30_000);
});
