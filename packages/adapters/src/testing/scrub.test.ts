import { describe, expect, it } from "vitest";
import type { Exchange } from "../http/client.ts";
import { toFixture } from "./record.ts";
import { createScrubber, REDACTED } from "./scrub.ts";

// Planted values: shaped like the real thing, never real.
const TOKEN = "A21AAPlantedTokenValue0123456789abcdefghijklmnop";
const SECRET = "EPlantedClientSecret0123456789";
const CLIENT_ID = "AaPlantedClientId0123456789";
const EMAIL = "sb-buyer42@personal.example.com";
const MERCHANT_EMAIL = "sb-seller7@business.example.com";
const CARD = "4111111111111111";
const PAYER_ID = "QYR5Z8XDVJNXQ";

const exchange: Exchange = {
  vendor: "paypal",
  attempt: 1,
  durationMs: 10,
  request: {
    method: "POST",
    url: `https://api-m.sandbox.paypal.com/v1/x?email=${EMAIL}`,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      cookie: "sid=abc",
      "openai-organization": "org-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      payment_source: { card: { number: CARD, security_code: "123", name: "Asha Verma" } },
      client_secret: SECRET,
      note: `contact ${EMAIL} from 203.0.113.9`,
    }),
  },
  response: {
    status: 201,
    headers: { "set-cookie": "x=y", "paypal-debug-id": "f00d", "content-type": "application/json" },
    body: JSON.stringify({
      id: "2KC08730ML031160C",
      access_token: TOKEN,
      payer: { payer_id: PAYER_ID, email_address: EMAIL, name: { given_name: "Asha", surname: "Verma" } },
      purchase_units: [
        {
          payee: { email_address: MERCHANT_EMAIL, merchant_id: "7XKL3NQ2" },
          payments: { captures: [{ id: "6BC19320SY177903T" }] },
          shipping: { address: { address_line_1: "12 MG Road", postal_code: "560001", country_code: "IN" } },
        },
      ],
      debug_id: "abc123",
      echoed: `client ${CLIENT_ID}`,
    }),
  },
};

describe("scrubber", () => {
  const scrubber = createScrubber({ secrets: () => [CLIENT_ID, SECRET, TOKEN] });
  const fixture = toFixture(exchange, scrubber, "M0-04", new Date("2026-10-29T00:00:00Z"));
  const out = JSON.stringify(fixture);

  it.each([
    ["token", TOKEN],
    ["secret", SECRET],
    ["client id", CLIENT_ID],
    ["email", EMAIL],
    ["merchant email", MERCHANT_EMAIL],
    ["card number", CARD],
    ["payer id", PAYER_ID],
    ["cookie", "sid=abc"],
    ["OpenAI org", "org-123"],
    ["name", "Asha"],
    ["address", "MG Road"],
    ["IP", "203.0.113.9"],
    ["CVV", '"123"'],
  ])("removes the planted %s", (_label, planted) => {
    expect(out).not.toContain(planted);
  });

  it("keeps flow ids, debug ids and the allow-listed headers only", () => {
    expect(out).toContain("2KC08730ML031160C");
    expect(out).toContain("6BC19320SY177903T");
    expect(out).toContain("abc123");
    expect(fixture.request.headers).toEqual({ "content-type": "application/json" });
    expect(fixture.response.headers).toEqual({
      "paypal-debug-id": "f00d",
      "content-type": "application/json",
    });
    expect(fixture.meta).toMatchObject({ env: "sandbox", scrubbed: true, ticket: "M0-04" });
  });

  it("uses stable placeholders on example.test", () => {
    const body = fixture.response.body as {
      access_token: string;
      payer: { email_address: string; payer_id: string };
      purchase_units: { payee: { email_address: string; merchant_id: string } }[];
    };
    expect(body.access_token).toBe(REDACTED);
    expect(body.payer.email_address).toBe("payer-1@example.test");
    expect(body.payer.payer_id).toBe("PAYER-1");
    expect(body.purchase_units[0]?.payee).toEqual({
      email_address: "merchant-1@example.test",
      merchant_id: "MERCHANT-1",
    });
    // the same email in the URL maps to the same placeholder
    expect(fixture.request.url).toContain("payer-1@example.test");
  });
});
