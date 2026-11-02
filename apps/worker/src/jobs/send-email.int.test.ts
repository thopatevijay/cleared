// M3-08 `notification.send_email` over msw (the recorded M1-05 Resend send, fixtures/resend/send-email.json):
// - AC 3: a recipient not in EMAIL_RECIPIENT_ALLOWLIST is never sent (0 Resend calls; `refused`, no error)
// - an allowlisted seller gets one send with the notification id as Idempotency-Key; sent_via/sent_at and
//   Resend's id are recorded; the body links to APP_BASE_URL and carries no evidence text
// - a demo workspace (no seller email) is in-app only (`no_recipient`, 0 calls)
// - AC 4: Resend 500 retries with backoff (pg-boss), then lands in the DLQ; the in-app row still exists
import { randomUUID } from "node:crypto";
import {
  createHttpClient,
  createLogger,
  createResendSender,
  RESEND_EMAILS_URL,
  withRecipientGuard,
  type EmailSender,
} from "@cleared/adapters";
import { addMinutes, deadlineAlert, WorkspaceIdSchema, type Instant } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  platform,
  sendEnvelope,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import { consumeOne } from "../consume.ts";
import { notify } from "../consumers/notifications.ts";
import { dlqName } from "../queues.ts";
import { dbAvailable, harness, testQueue, until, url, type Harness } from "../../test/helpers.ts";
import { sendEmailHandler } from "./send-email.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
const log = createLogger({ service: "worker-test", level: "silent" });
const DUE = "2026-11-09T04:59:59.000Z" as Instant;
const NOW = new Date(addMinutes(DUE, -18 * 60));
const APP = "https://cleared.example";
const ALLOWED = `seller-${randomUUID().slice(0, 8)}@example.test`;
const ALLOWED_DLQ = `seller-${randomUUID().slice(0, 8)}@example.test`;
const recorded = loadFixture("resend/send-email");

interface Sent {
  readonly key: string | null;
  readonly body: { to: string[]; subject: string; text: string; html: string };
}
let sent: Sent[] = [];

function serveResend(status = 200): void {
  server.use(
    http.post(RESEND_EMAILS_URL, async ({ request }) => {
      sent.push({
        key: request.headers.get("idempotency-key"),
        body: (await request.json()) as Sent["body"],
      });
      return status === 200
        ? new HttpResponse(responseText(recorded), { status: 200, headers: recorded.response.headers })
        : HttpResponse.json({ name: "internal_server_error" }, { status });
    }),
  );
}

function sender(maxRetries = 0): EmailSender {
  const h = createHttpClient({ vendor: "resend", timeoutMs: 2_000, maxRetries, baseDelayMs: 10, log: false });
  return withRecipientGuard(
    createResendSender({ apiKey: "re_test", from: "Cleared <a@example.test>", http: h }),
    [ALLOWED, ALLOWED_DLQ],
  );
}

const handler = (s: EmailSender) =>
  sendEmailHandler({ db, email: { sender: s, appBaseUrl: APP }, now: () => NOW });

/** A workspace (seller with `email`, or demo) with one T-24 notification and its committed email job. */
async function scene(email: string | null) {
  const ws = await platform(db).workspaces.create({
    kind: email === null ? "demo" : "seller",
    locale: "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
  });
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws.id));
  if (email !== null) await repos.users.insert({ email });
  const d = await repos.disputes.insert({
    disputeId: `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    status: "WAITING_FOR_SELLER_RESPONSE",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: "120.00",
    currency: "USD",
    sellerResponseDueDate: new Date(DUE),
  });
  const draft = deadlineAlert({
    disputeRowId: d.id,
    dueDate: DUE,
    open: true,
    now: NOW.toISOString() as Instant,
    amount: { amount: "120.00", currency: "USD" },
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  });
  if (draft === null) throw new Error("no alert");
  const row = await withTransaction(db, (tx) =>
    notify({ db, publisher: createPublisher(db, boss) }, tx, repos.workspaceId, draft),
  );
  if (row === null) throw new Error("no row");
  return { repos, ws: ws.id, id: row.id };
}

async function deliver(s: EmailSender, sc: Awaited<ReturnType<typeof scene>>): Promise<void> {
  const envelope = {
    messageId: randomUUID(),
    correlationId: randomUUID(),
    data: { notificationId: sc.id, workspaceId: sc.ws },
  };
  const job = { id: randomUUID(), retryCount: 0, retryLimit: 5, data: envelope } as JobWithMetadata<unknown>;
  await consumeOne({ db, log, now: () => NOW }, "notification.send_email", handler(s), job);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server.listen({ onUnhandledRequest: "error" });
  boss = await createQueue(db, { background: false, max: 2 });
});
afterEach(() => {
  server.resetHandlers();
  sent = [];
});
afterAll(async () => {
  server.close();
  if (dbAvailable) await boss.stop({ graceful: false });
  await closeDb(db);
});

describe.skipIf(!dbAvailable)("notification.send_email", () => {
  it("AC 3: a recipient outside the allowlist gets 0 Resend calls; the row says refused", async () => {
    serveResend();
    const sc = await scene(`stranger-${randomUUID().slice(0, 8)}@example.test`);
    await deliver(sender(), sc);
    expect(sent).toHaveLength(0);
    expect(await sc.repos.notifications.get(sc.id)).toMatchObject({
      emailStatus: "refused",
      sentVia: null,
      sentAt: null,
    });
  });

  it("an allowlisted seller: one send keyed on the notification; sent_via, sent_at and the Resend id recorded", async () => {
    serveResend();
    const sc = await scene(ALLOWED);
    await deliver(sender(), sc);
    await deliver(sender(), sc); // a redelivery after success sends nothing
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail?.key).toBe(`notification-${sc.id}`);
    expect(mail?.body.to).toEqual([ALLOWED]);
    expect(mail?.body.subject).toBe(
      "Reply to the $120.00 USD dispute is due in 18 hours (9 Nov, 10:29 IST).",
    );
    const d = (await sc.repos.notifications.get(sc.id))?.refId ?? "";
    expect(mail?.body.text).toContain(`${APP}/en/disputes/${d}`);
    expect(mail?.body.html).not.toMatch(/<img|<script/i);
    expect(await sc.repos.notifications.get(sc.id)).toMatchObject({
      emailStatus: "sent",
      sentVia: "email",
      sentAt: NOW,
      emailId: (JSON.parse(responseText(recorded)) as { id: string }).id,
    });
  });

  it("a demo workspace is in-app only: no_recipient, 0 calls", async () => {
    serveResend();
    const sc = await scene(null);
    await deliver(sender(), sc);
    expect(sent).toHaveLength(0);
    expect((await sc.repos.notifications.get(sc.id))?.emailStatus).toBe("no_recipient");
  });
});

describe.skipIf(!dbAvailable)("notification.send_email: Resend 500 (compose Postgres, real pg-boss)", () => {
  const queue = testQueue("send-email");
  const attempts: JobWithMetadata<unknown>[] = [];
  let h: Harness;

  beforeAll(async () => {
    const send = handler(sender(1));
    h = await harness([
      {
        queue: { name: queue, expireInSeconds: 30, retryLimit: 2, retryDelay: 1 },
        handler: (data, ctx) => {
          attempts.push(ctx.job);
          return send(data, ctx);
        },
      },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it("AC 4: retries with backoff, then the DLQ; the in-app notification still exists, marked failed", async () => {
    serveResend(500);
    const sc = await scene(ALLOWED_DLQ);
    const envelope = {
      messageId: randomUUID(),
      correlationId: randomUUID(),
      data: { notificationId: sc.id, workspaceId: sc.ws },
    };
    const id = (await withTransaction(h.db, (tx) => sendEnvelope(h.boss, tx, queue, envelope))) ?? "";
    await until(
      async () =>
        (await h.boss.findJobs(dlqName(queue), { data: envelope })).some((j) => j.state === "completed"),
      30_000,
    );
    const [original] = await h.boss.findJobs(queue, { id });
    expect(original).toMatchObject({
      state: "failed",
      retryCount: 2,
      retryLimit: 2,
      deadLetter: dlqName(queue),
    });
    // pg-boss backoff: retryDelay 1 s with backoff and jitter, about 1–2 s, then about 2–4 s
    expect(attempts.map((a) => a.retryCount)).toEqual([0, 1, 2]);
    const delays = [1, 2].map(
      (n) => (attempts[n]?.startAfter.getTime() ?? 0) - (attempts[n - 1]?.startedOn.getTime() ?? 0),
    );
    expect(delays[0]).toBeGreaterThanOrEqual(900);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? Infinity);
    // the shared client retries a 5xx once per attempt (2 + 2), then its breaker opens on the 5th failure
    // (threshold 5), so the 3rd attempt makes 1 call; every call carries the same Idempotency-Key
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.key))).toEqual(new Set([`notification-${sc.id}`]));
    expect(await sc.repos.notifications.get(sc.id)).toMatchObject({
      kind: "deadline_t24",
      emailStatus: "failed",
      sentVia: null,
      readAt: null,
    });
  }, 40_000);
});
