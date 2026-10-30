import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  CaptureIdSchema,
  compareInstants,
  DisputeIdSchema,
  domainError,
  domainErrorEnvelope,
  err,
  errorEnvelope,
  ErrorEnvelopeSchema,
  fromEpochMs,
  InstantSchema,
  ok,
  OrderIdSchema,
  parseId,
  parseInstant,
  Sha256Schema,
  toEpochMs,
  WorkspaceIdSchema,
} from "../src/index.ts";

describe("Result", () => {
  it("wraps values and errors", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });
});

describe("branded ids", () => {
  it("accepts UUIDs for our ids and PayPal tokens verbatim", () => {
    expect(parseId(WorkspaceIdSchema, "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b").ok).toBe(true);
    expect(parseId(ActionIdSchema, "6f1c1d2e-0a4b-4c8d-9e7f-1a2b3c4d5e6f").ok).toBe(true);
    expect(parseId(CaptureIdSchema, "6BC19320SY177903T")).toEqual({ ok: true, value: "6BC19320SY177903T" });
    expect(parseId(OrderIdSchema, "2KC08730ML031160C").ok).toBe(true);
    expect(parseId(DisputeIdSchema, "PP-R-UVC-10195076").ok).toBe(true);
  });

  it.each([
    [WorkspaceIdSchema, "not-a-uuid"],
    [CaptureIdSchema, ""],
    [CaptureIdSchema, "has space"],
    [DisputeIdSchema, "-leading-dash"],
    [OrderIdSchema, 42],
  ] as const)("rejects %#", (schema, raw) => {
    expect(parseId(schema, raw)).toEqual({
      ok: false,
      error: { code: "invalid_id", message: "not a valid identifier", details: { raw } },
    });
  });

  it("sha256 is 64 lowercase hex", () => {
    expect(Sha256Schema.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256Schema.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256Schema.safeParse("a".repeat(63)).success).toBe(false);
  });
});

describe("Instant", () => {
  it.each([
    ["2026-10-29T04:57:06Z", "2026-10-29T04:57:06.000Z"],
    ["2026-10-29T05:16:59.065Z", "2026-10-29T05:16:59.065Z"],
    ["2026-10-29T10:27:06+05:30", "2026-10-29T04:57:06.000Z"],
  ])("normalises %s to UTC", (raw, canonical) => {
    expect(parseInstant(raw)).toEqual({ ok: true, value: canonical });
    expect(InstantSchema.safeParse(canonical).success).toBe(true);
  });

  it.each(["2026-10-29", "2026-10-29T04:57:06", "yesterday", "2026-13-45T99:00:00Z"])("rejects %s", (raw) => {
    const r = parseInstant(raw);
    expect(r.ok ? null : r.error.code).toBe("invalid_instant");
  });

  it("InstantSchema accepts only the canonical form", () => {
    expect(InstantSchema.safeParse("2026-10-29T04:57:06Z").success).toBe(false);
    expect(InstantSchema.safeParse("nope").success).toBe(false);
  });

  it("compares and converts", () => {
    const a = fromEpochMs(0);
    const b = fromEpochMs(1);
    expect(a).toBe("1970-01-01T00:00:00.000Z");
    expect(toEpochMs(b)).toBe(1);
    expect(compareInstants(a, b)).toBeLessThan(0);
    expect(compareInstants(b, a)).toBeGreaterThan(0);
    expect(compareInstants(a, a)).toBe(0);
  });
});

describe("error envelope (ADR 0003)", () => {
  it("builds { error: { code, message, details, correlationId } }", () => {
    expect(errorEnvelope({ code: "not_found", message: "No such payment", correlationId: "c-1" })).toEqual({
      error: { code: "not_found", message: "No such payment", details: null, correlationId: "c-1" },
    });
  });

  it("maps a domain error", () => {
    const e = domainError("stale_update", "older", { a: 1 });
    expect(domainErrorEnvelope(e, "c-2")).toEqual({
      error: { code: "stale_update", message: "older", details: { a: 1 }, correlationId: "c-2" },
    });
    expect(domainError("invalid_id", "x").details).toBeNull();
  });

  it("rejects extra keys, a non-snake code and a missing correlation id", () => {
    const valid = { error: { code: "x", message: "m", details: null, correlationId: "c" } };
    expect(ErrorEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...valid.error, code: "Not-Found" } }).success).toBe(
      false,
    );
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...valid.error, correlationId: "" } }).success).toBe(
      false,
    );
    expect(() => errorEnvelope({ code: "x", message: "", correlationId: "c" })).toThrow();
  });
});
