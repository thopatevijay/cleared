// verify-webhook-signature postback body: the event goes back exactly as received (PayPal: parsing and
// re-serialising "can fail verification"), so the raw text must appear byte-for-byte.
import { describe, expect, it } from "vitest";
import { rfc3339, verifyRequestBody } from "./webhooks.ts";

const headers = {
  "PayPal-Transmission-Id": "t-1",
  "paypal-transmission-time": "2026-10-29T06:00:00Z",
  "paypal-transmission-sig": "c2ln",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-auth-algo": "SHA256withRSA",
};

describe("rfc3339 (event-list filters reject fractional seconds)", () => {
  it.each([
    ["2026-10-29T06:00:00.123Z", "2026-10-29T06:00:00Z"],
    ["2026-10-29T06:00:00Z", "2026-10-29T06:00:00Z"],
    ["2026-10-29T11:30:00.5+05:30", "2026-10-29T11:30:00+05:30"],
  ])("%s → %s", (input, out) => {
    expect(rfc3339(input)).toBe(out);
  });
});

describe("verifyRequestBody", () => {
  it("splices the raw event in verbatim (whitespace, key order and escapes kept)", () => {
    const raw = '{"z":1,  "a":"\\u00e9", "id":"WH-1" ,"n":1.50}';
    const body = verifyRequestBody({ rawBody: raw, headers, webhookId: "WH-ID" });
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: headers["paypal-cert-url"],
      transmission_id: "t-1",
      transmission_sig: "c2ln",
      transmission_time: "2026-10-29T06:00:00Z",
      webhook_id: "WH-ID",
      webhook_event: { z: 1, a: "é", id: "WH-1", n: 1.5 },
    });
  });

  it("accepts the raw body as bytes", () => {
    const raw = '{"id":"WH-2"}';
    const body = verifyRequestBody({ rawBody: new TextEncoder().encode(raw), headers, webhookId: "W" });
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
  });
});
