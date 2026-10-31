import { describe, expect, it } from "vitest";
import { DOMAIN_EVENT_TYPES, DomainEventSchema, type DomainEvent } from "../src/index.ts";

const WS = "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b";
const UUID = "6f1c1d2e-0a4b-4c8d-9e7f-1a2b3c4d5e6f";
const AT = "2026-10-29T05:20:04.000Z";
const CAP = "6BC19320SY177903T";
const SHA = "a".repeat(64);
const pending = { status: "PENDING", reason: "BUYER_COMPLAINT" };
const action = { actionId: UUID, kind: "provide_evidence" };

/** One valid sample per event in architecture §2, in its order. */
const samples: Record<DomainEvent["type"], Record<string, unknown>> = {
  "payment.captured": {
    captureId: CAP,
    orderId: "2KC08730ML031160C",
    amount: { amount: "42.00", currency: "USD" },
    state: { status: "COMPLETED", reason: null },
  },
  "payment.status_changed": {
    captureId: CAP,
    from: { status: "COMPLETED", reason: null },
    to: pending,
    source: "webhook",
    updateTime: AT,
  },
  "evidence.added": { packId: UUID, evidenceItemId: UUID, kind: "delivery", sha256: SHA },
  "pack.checked": { packId: UUID, checkedAt: AT },
  "hold.opened": { holdId: UUID, captureId: CAP, reason: "BUYER_COMPLAINT" },
  "hold.released": { holdId: UUID, captureId: CAP, releasedAt: AT },
  "dispute.opened": {
    disputeId: "PP-R-UVC-10195076",
    captureId: CAP,
    status: "OPEN",
    sellerResponseDueDate: null,
  },
  "dispute.status_changed": {
    disputeId: "PP-R-UVC-10195076",
    from: "OPEN",
    to: "WAITING_FOR_SELLER_RESPONSE",
    source: "poll",
    updateTime: AT,
  },
  "action.proposed": { ...action, payloadSha256: SHA, runId: "9b2f6a8e-3c1d-4e5f-8a7b-6c5d4e3f2a1b" },
  "action.approved": { ...action, payloadSha256: SHA, approvedBy: "seller" },
  "action.executed": { ...action, paypalDebugId: "f561822f3f12c" },
  "action.failed": { ...action, paypalDebugId: null, reason: "UNPROCESSABLE_ENTITY" },
  "action.unknown": { ...action },
};

function envelope(type: string, data: unknown, version: unknown = 1) {
  return { type, version, workspaceId: WS, occurredAt: AT, data };
}

describe("domain events", () => {
  it("covers every event in architecture §2, payment.captured … action.unknown", () => {
    expect(DOMAIN_EVENT_TYPES).toEqual([
      "payment.captured",
      "payment.status_changed",
      "evidence.added",
      "pack.checked",
      "hold.opened",
      "hold.released",
      "dispute.opened",
      "dispute.status_changed",
      "action.proposed",
      "action.approved",
      "action.executed",
      "action.failed",
      "action.unknown",
    ]);
  });

  it.each(Object.entries(samples))("%s parses at version 1", (type, data) => {
    const parsed = DomainEventSchema.parse(envelope(type, data));
    expect(parsed.type).toBe(type);
    expect(parsed.version).toBe(1);
  });

  it.each(Object.keys(samples))("%s rejects version 2 and an empty payload", (type) => {
    expect(DomainEventSchema.safeParse(envelope(type, samples[type as DomainEvent["type"]], 2)).success).toBe(
      false,
    );
    if (type !== "action.unknown")
      expect(DomainEventSchema.safeParse(envelope(type, {})).success).toBe(false);
  });

  it("rejects an unknown type, a non-canonical instant and a non-canonical amount", () => {
    expect(DomainEventSchema.safeParse(envelope("payment.vanished", {})).success).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        ...envelope("pack.checked", samples["pack.checked"]),
        occurredAt: "2026-10-29T05:20:04Z",
      }).success,
    ).toBe(false);
    const captured = { ...samples["payment.captured"], amount: { amount: "42", currency: "USD" } };
    expect(DomainEventSchema.safeParse(envelope("payment.captured", captured)).success).toBe(false);
  });
});
