import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";
import { rawBodySummary, redact } from "./redact.ts";

const COOKIE = "__Host-cleared_session=s3cr3t-session-value";
const TOKEN = "A21AAFakeAccessTokenValue123";
const EMAIL = "buyer.jane@example.test";
const RAW = JSON.stringify({ id: "WH-1", resource: { payer: { email_address: EMAIL } } });

function capture() {
  const out: string[] = [];
  const log = createLogger({
    service: "test",
    env: { NODE_ENV: "test", RENDER_GIT_COMMIT: "abc123" },
    destination: { write: (s: string) => void out.push(s) },
  });
  return { log, out };
}

describe("obs redaction (M1-08 AC: redaction)", () => {
  it("prints none of a cookie, a token, an email or a webhook raw body", () => {
    const { log, out } = capture();
    log.info(
      {
        headers: { cookie: COOKIE, authorization: `Bearer ${TOKEN}`, "set-cookie": COOKIE },
        auth: { token: TOKEN, access_token: TOKEN, client_secret: "cs-123" },
        nested: { deeper: { still: { email: EMAIL, payer: { name: "Jane" } } } },
        note: `contact ${EMAIL} please`,
        raw: RAW,
      },
      `webhook from ${EMAIL}`,
    );
    const serialised = out.join("");
    for (const secret of [COOKIE, "s3cr3t-session-value", TOKEN, "Bearer ", EMAIL, "cs-123", RAW, "Jane"]) {
      expect(serialised).not.toContain(secret);
    }
    const line = JSON.parse(serialised) as Record<string, unknown>;
    const sha256 = createHash("sha256").update(RAW).digest("hex");
    expect(line["raw"]).toEqual({ size: Buffer.byteLength(RAW), sha256 });
    expect(line["msg"]).toBe("webhook from [email]");
    expect(line).toMatchObject({ service: "test", env: "test", release: "abc123" });
  });

  it("redacts inside arrays and errors, and survives cycles", () => {
    const cyclic: Record<string, unknown> = { email: EMAIL };
    cyclic["self"] = cyclic;
    const err = new Error(`failed for ${EMAIL}`);
    const out = JSON.stringify(redact({ list: [{ token: TOKEN }], err, cyclic }));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(EMAIL);
    expect(out).toContain("[Circular]");
  });

  it("summarises raw bodies of any shape", () => {
    expect(rawBodySummary("abc").size).toBe(3);
    expect(rawBodySummary(new Uint8Array([1, 2])).size).toBe(2);
    expect(rawBodySummary({ a: 1 }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits release outside Render", () => {
    const out: string[] = [];
    createLogger({
      service: "worker",
      env: {},
      destination: { write: (s: string) => void out.push(s) },
    }).info("x");
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ service: "worker", env: "development" });
    expect(out[0]).not.toContain("release");
  });
});
