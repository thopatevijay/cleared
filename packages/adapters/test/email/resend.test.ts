// M1-05: the Resend sender replays the recorded live send (fixtures/resend/send-email.json); the
// recipient guard refuses before any request; EN/HI templates.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendSender, RESEND_EMAILS_URL } from "../../src/email/resend.ts";
import { parseAllowlist, withRecipientGuard, type EmailSender } from "../../src/email/sender.ts";
import { magicLinkEmail } from "../../src/email/templates/render.ts";
import { HttpStatusError } from "../../src/http/errors.ts";
import { loadFixture, responseText } from "../../src/testing/fixture.ts";
import { startReplay, type Replay } from "../../src/testing/replay.ts";

const FIXTURE = "resend/send-email";
const message = {
  to: "seller@example.test",
  subject: "s",
  text: "t",
  html: "<p>t</p>",
  idempotencyKey: "link-1",
};

let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

describe("createResendSender (replaying the recorded live send)", () => {
  it("returns the email id from the recorded response", async () => {
    replay = startReplay([FIXTURE]);
    const sender = createResendSender({ apiKey: "re_test_key", from: "Cleared <onboarding@resend.dev>" });
    const result = await sender.send(message);
    expect(loadFixture(FIXTURE).response.body).toEqual({ id: "01a18db5-1681-7323-90b9-3a3f29b73659" });
    expect(result).toEqual({ kind: "sent", id: "01a18db5-1681-7323-90b9-3a3f29b73659" });
    expect(replay.unused()).toEqual([]);
  });

  it("sends the bearer key, the idempotency key and the message as JSON", async () => {
    const seen: { headers: Headers; body: unknown }[] = [];
    const fixture = loadFixture(FIXTURE);
    const server = setupServer(
      http.post(RESEND_EMAILS_URL, async ({ request }) => {
        seen.push({ headers: request.headers, body: await request.json() });
        return new HttpResponse(responseText(fixture), {
          status: fixture.response.status,
          headers: fixture.response.headers,
        });
      }),
    );
    server.listen({ onUnhandledFrame: "error" });
    try {
      await createResendSender({ apiKey: "re_test_key", from: "Cleared <onboarding@resend.dev>" }).send(
        message,
      );
    } finally {
      server.close();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(seen[0]?.headers.get("idempotency-key")).toBe("link-1");
    expect(seen[0]?.body).toEqual({
      from: "Cleared <onboarding@resend.dev>",
      to: ["seller@example.test"],
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
  });

  it("raises HttpStatusError on a 4xx (no retry)", async () => {
    let calls = 0;
    const server = setupServer(
      http.post(RESEND_EMAILS_URL, () => {
        calls += 1;
        return HttpResponse.json({ name: "validation_error", message: "bad" }, { status: 422 });
      }),
    );
    server.listen({ onUnhandledFrame: "error" });
    try {
      const sender = createResendSender({ apiKey: "k", from: "f@example.test" });
      await expect(sender.send(message)).rejects.toBeInstanceOf(HttpStatusError);
    } finally {
      server.close();
    }
    expect(calls).toBe(1);
  });

  it("refuses empty configuration", () => {
    expect(() => createResendSender({ apiKey: "", from: "f@example.test" })).toThrow(/RESEND_API_KEY/);
    expect(() => createResendSender({ apiKey: "k", from: "" })).toThrow(/EMAIL_FROM/);
  });
});

describe("withRecipientGuard", () => {
  it("refuses a non-allowlisted recipient with no Resend request, and logs the reason", async () => {
    replay = startReplay([FIXTURE]);
    const log = vi.fn();
    const sender = withRecipientGuard(
      createResendSender({ apiKey: "k", from: "f@example.test" }),
      ["owner@example.test"],
      log,
    );
    const result = await sender.send({ ...message, to: "stranger@elsewhere.test" });
    expect(result).toEqual({ kind: "refused", reason: "recipient_not_allowlisted" });
    expect(replay.unused()).toEqual([FIXTURE]); // the recorded response was never requested
    expect(replay.unmatched()).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      msg: "email refused",
      reason: "recipient_not_allowlisted",
      recipientDomain: "elsewhere.test",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("stranger");
  });

  it("passes an allowlisted recipient through, case-insensitively", async () => {
    const inner: EmailSender = { send: vi.fn(() => Promise.resolve({ kind: "sent" as const, id: "e1" })) };
    const sender = withRecipientGuard(inner, ["Owner@Example.test"]);
    await expect(sender.send({ ...message, to: "OWNER@example.TEST" })).resolves.toEqual({
      kind: "sent",
      id: "e1",
    });
  });

  it("is a no-op when the allowlist is unset", () => {
    const inner: EmailSender = { send: vi.fn() };
    expect(withRecipientGuard(inner, null)).toBe(inner);
  });
});

describe("parseAllowlist", () => {
  it("parses, trims and lower-cases; empty means no guard", () => {
    expect(parseAllowlist(" A@example.test, b@example.test ,")).toEqual(["a@example.test", "b@example.test"]);
    expect(parseAllowlist(undefined)).toBeNull();
    expect(parseAllowlist("  ")).toBeNull();
  });
  it("throws on an entry that is not an address (a typo must not open the guard)", () => {
    expect(() => parseAllowlist("a@example.test,not-an-email")).toThrow(/not an email address/);
  });
});

describe("magic-link templates", () => {
  const url = "https://app.example.test/api/auth/verify?token=abc&x=<y>";
  it.each(["en", "hi"] as const)("%s carries the link in text and escaped in HTML", (locale) => {
    const e = magicLinkEmail(locale, { url, minutes: 15 });
    expect(e.text).toContain(url);
    expect(e.text).toContain("15");
    expect(e.html).toContain('href="https://app.example.test/api/auth/verify?token=abc&amp;x=&lt;y&gt;"');
    expect(e.html).not.toContain("<y>");
  });
  it("Hindi is in Devanagari, English is not", () => {
    expect(magicLinkEmail("hi", { url, minutes: 15 }).subject).toMatch(/[ऀ-ॿ]/);
    expect(magicLinkEmail("en", { url, minutes: 15 }).subject).toBe("Your Cleared sign-in link");
  });
});
