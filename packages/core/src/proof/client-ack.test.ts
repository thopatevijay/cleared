// M3-06: client acknowledgement rules (token hash, expiry, status, accept form, canonical evidence text).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACK_LINK_TTL_MS,
  ackLinkExpiry,
  ackLinkStatus,
  ackTokenHash,
  AckSubmitSchema,
  AckTokenSchema,
  clientAckEvidence,
  parseClientAckText,
  type AckLinkFacts,
} from "./client-ack.ts";

const SHA = "a".repeat(64);
const NOW = new Date("2026-11-02T10:00:00.000Z");
const link = (over: Partial<AckLinkFacts> = {}): AckLinkFacts => ({
  scopeSha256: SHA,
  expiresAt: new Date(NOW.getTime() + 1000),
  acceptedAt: null,
  revokedAt: null,
  ...over,
});

describe("client-ack token", () => {
  it("accepts 43-char base64url tokens only", () => {
    expect(AckTokenSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(AckTokenSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(AckTokenSchema.safeParse(`${"A".repeat(42)}=`).success).toBe(false);
    expect(AckTokenSchema.safeParse(`${"A".repeat(42)}/`).success).toBe(false);
  });
  it("hashes with sha256 hex and never returns the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const h = ackTokenHash(token);
    expect(h).toBe(createHash("sha256").update(token).digest("hex"));
    expect(h).not.toContain(token);
  });
});

describe("client-ack expiry", () => {
  it("is 30 days without a workspace expiry", () => {
    expect(ackLinkExpiry(NOW, null).getTime()).toBe(NOW.getTime() + ACK_LINK_TTL_MS);
  });
  it("is the workspace expiry when that comes first", () => {
    const ws = new Date(NOW.getTime() + 3600_000);
    expect(ackLinkExpiry(NOW, ws)).toEqual(ws);
  });
  it("keeps 30 days when the workspace expires later", () => {
    const ws = new Date(NOW.getTime() + 2 * ACK_LINK_TTL_MS);
    expect(ackLinkExpiry(NOW, ws).getTime()).toBe(NOW.getTime() + ACK_LINK_TTL_MS);
  });
});

describe("client-ack status", () => {
  it.each([
    ["pending", link(), SHA],
    ["accepted", link({ acceptedAt: NOW }), SHA],
    ["accepted", link({ acceptedAt: NOW }), "b".repeat(64)],
    ["revoked", link({ revokedAt: NOW }), SHA],
    ["scope_changed", link(), "b".repeat(64)],
    ["scope_changed", link(), null],
    ["expired", link({ expiresAt: NOW }), SHA],
  ] as const)("%s", (want, l, current) => {
    expect(ackLinkStatus(l, current, NOW)).toBe(want);
  });
});

describe("client-ack submit", () => {
  it("trims and NFC-normalises the name", () => {
    const r = AckSubmitSchema.parse({ name: "  Asha Raó ", agree: true });
    expect(r.name).toBe("Asha Raó");
  });
  it.each([
    [{ name: "", agree: true }],
    [{ name: "   ", agree: true }],
    [{ name: "x".repeat(121), agree: true }],
    [{ name: "Asha\u0000", agree: true }],
    [{ name: "Asha", agree: false }],
    [{ name: "Asha" }],
    [{ name: "Asha", agree: true, ip: "1.2.3.4" }],
  ])("refuses %j", (body) => {
    expect(AckSubmitSchema.safeParse(body).success).toBe(false);
  });
  it("accepts 120 characters", () => {
    expect(AckSubmitSchema.safeParse({ name: "x".repeat(120), agree: true }).success).toBe(true);
  });
});

describe("client-ack evidence", () => {
  const record = {
    scopeSha256: SHA,
    typedName: "Asha Rao",
    acceptedAt: NOW,
    ip: "198.51.100.7",
    userAgent: "Mozilla/5.0",
  };
  it("is canonical JSON with sorted keys and its sha256 matches the text", () => {
    const e = clientAckEvidence(record);
    expect(e.text).toBe(
      `{"accepted_at":"2026-11-02T10:00:00.000Z","ip":"198.51.100.7","scope_sha256":"${SHA}","typed_name":"Asha Rao","user_agent":"Mozilla/5.0"}`,
    );
    expect(e.sha256).toBe(createHash("sha256").update(e.text, "utf8").digest("hex"));
  });
  it("caps the user agent and escapes markup as JSON text", () => {
    const e = clientAckEvidence({ ...record, typedName: '<script>"x"</script>', userAgent: "u".repeat(600) });
    const parsed = JSON.parse(e.text) as Record<string, string>;
    expect(parsed["user_agent"]).toHaveLength(512);
    expect(parsed["typed_name"]).toBe('<script>"x"</script>');
  });
  it("parses back into the record the evidence list shows", () => {
    expect(parseClientAckText(clientAckEvidence(record).text)).toEqual({
      ...record,
      acceptedAt: NOW.toISOString(),
    });
    expect(parseClientAckText("not json")).toBeNull();
    expect(parseClientAckText('{"typed_name":"x"}')).toBeNull();
  });
});
