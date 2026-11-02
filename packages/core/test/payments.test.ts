import { describe, expect, it } from "vitest";
import {
  applyMirror,
  isHold,
  mapCapture,
  mapPaymentState,
  mirrorEnum,
  mirroredRaw,
  parseInstant,
  type Instant,
  type PaymentState,
} from "../src/index.ts";
import { captureBodies } from "./helpers/fixtures.ts";

function instant(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("capture mapping against the recorded sandbox fixtures (M0-04 / M0-05)", () => {
  const bodies = captureBodies("orders", "disputes");

  it("finds every capture body in fixtures/paypal/orders and fixtures/paypal/disputes", () => {
    // 7 direct GET capture responses + 5 captures inside order responses (recorded 2026-10-29), plus
    // M1-04 (2026-10-30): 2 capture GETs and 1 capture inside the test-payment capture response, plus
    // M3-10 (2026-11-02): 3 captures inside the live review-hold pool's order GETs (orders/pool/)
    expect(bodies.length).toBe(18);
    expect(new Set(bodies.map((b) => b.file.split("/")[0]))).toEqual(new Set(["orders", "disputes"]));
  });

  it.each(captureBodies("orders", "disputes").map((b) => [`${b.file} (${b.where})`, b.body] as const))(
    "%s maps with no unrecognised value",
    (_name, body) => {
      const r = mapCapture(body);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { state } = r.value;
      expect(state.status.kind).toBe("known");
      expect(mirroredRaw(state.status)).toBe(body.status);
      if (state.reason !== null) expect(state.reason.kind).toBe("known");
      expect(r.value.updateTime).not.toBeNull();
      expect(r.value.captureId).toBe(body.id);
      expect(isHold(state)).toBe(body.status === "PENDING");
    },
  );

  it("maps the held capture from the chargeback flow as PENDING / BUYER_COMPLAINT", () => {
    const held = bodies.find((b) => b.file === "disputes/full/capture-2-pending.json");
    const r = mapCapture(held?.body);
    expect(r.ok && r.value.state).toEqual({
      status: { kind: "known", value: "PENDING" },
      reason: { kind: "known", value: "BUYER_COMPLAINT" },
    });
  });

  it("maps the live review-hold pool's captures (M3-10) as PENDING / PENDING_REVIEW", () => {
    const pool = bodies.filter((b) => b.file.startsWith("orders/pool/"));
    expect(pool).toHaveLength(3);
    for (const b of pool) {
      const r = mapCapture(b.body);
      expect(r.ok && r.value.state).toEqual({
        status: { kind: "known", value: "PENDING" },
        reason: { kind: "known", value: "PENDING_REVIEW" },
      });
    }
  });

  it("reads amount, receivable, order id, custom_id and update_time from a GET capture", () => {
    const got = bodies.find((b) => b.file === "orders/get-capture-a.json");
    const r = mapCapture(got?.body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toEqual({ amount: "42.00", currency: "USD" });
    expect(r.value.receivable).toEqual({ amount: "40.42", currency: "USD" });
    expect(r.value.orderId).toBe("2KC08730ML031160C");
    expect(r.value.customId).toMatch(/^spike-/);
    expect(r.value.updateTime).toBe("2026-10-29T04:57:06.000Z");
  });
});

describe("capture mapping edge cases", () => {
  const base = {
    id: "6BC19320SY177903T",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "1.00" },
  };

  it("keeps an unknown status or reason verbatim, never coerced", () => {
    const r = mapCapture({ ...base, status: "ON_HOLD_NEW", status_details: { reason: "NEW_REASON" } });
    expect(r.ok && r.value.state).toEqual({
      status: { kind: "unrecognised", raw: "ON_HOLD_NEW" },
      reason: { kind: "unrecognised", raw: "NEW_REASON" },
    });
  });

  it("falls back to create_time, then null; tolerates a malformed order id", () => {
    const c = mapCapture({
      ...base,
      create_time: "2026-10-29T04:57:06Z",
      supplementary_data: { related_ids: { order_id: "bad id!" } },
    });
    expect(c.ok && c.value.updateTime).toBe("2026-10-29T04:57:06.000Z");
    expect(c.ok && c.value.orderId).toBeNull();
    const n = mapCapture(base);
    expect(n.ok && [n.value.updateTime, n.value.receivable, n.value.customId, n.value.orderId]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it.each([
    ["not an object", "x", "invalid_paypal_resource"],
    ["a malformed id", { ...base, id: "has space" }, "invalid_paypal_resource"],
    ["an unsupported currency", { ...base, amount: { currency_code: "XYZ", value: "1" } }, "invalid_money"],
    [
      "a bad receivable",
      { ...base, seller_receivable_breakdown: { net_amount: { currency_code: "USD", value: "1.999" } } },
      "invalid_money",
    ],
    ["a bad update_time", { ...base, update_time: "yesterday" }, "invalid_instant"],
  ])("rejects %s", (_name, body, code) => {
    const r = mapCapture(body);
    expect(r.ok ? null : r.error.code).toBe(code);
  });
});

describe("isHold", () => {
  const cases: [PaymentState, boolean][] = [
    [mapPaymentState("PENDING", "BUYER_COMPLAINT"), true],
    [mapPaymentState("PENDING", "SOMETHING_NEW"), true],
    [mapPaymentState("PENDING", null), false],
    [mapPaymentState("COMPLETED", null), false],
    [mapPaymentState("pending", "OTHER"), false],
  ];
  it.each(cases)("%j -> %s", (state, expected) => {
    expect(isHold(state)).toBe(expected);
  });
});

describe("applyMirror (event order is never trusted)", () => {
  const t1 = instant("2026-10-29T05:20:04Z");
  const t0 = instant("2026-10-29T05:16:55Z");
  const t2 = instant("2026-10-29T05:38:42.001Z");
  const prev = { value: "PENDING", updateTime: t1 };

  it("accepts the first value", () => {
    expect(applyMirror(null, "COMPLETED", t0)).toEqual({
      ok: true,
      value: { value: "COMPLETED", updateTime: t0 },
    });
  });

  it("rejects an older update_time", () => {
    const r = applyMirror(prev, "COMPLETED", t0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("stale_update");
      expect(r.error.details).toEqual({ storedUpdateTime: t1, receivedUpdateTime: t0 });
    }
  });

  it("rejects one millisecond older", () => {
    expect(applyMirror(prev, "COMPLETED", instant("2026-10-29T05:20:03.999Z")).ok).toBe(false);
  });

  it("accepts an equal update_time (replayed fetch is idempotent)", () => {
    expect(applyMirror(prev, "PENDING", instant("2026-10-29T05:20:04.000Z"))).toEqual({
      ok: true,
      value: { value: "PENDING", updateTime: t1 },
    });
  });

  it("accepts a newer update_time", () => {
    expect(applyMirror(prev, "COMPLETED", t2)).toEqual({
      ok: true,
      value: { value: "COMPLETED", updateTime: t2 },
    });
  });
});

describe("mirrorEnum", () => {
  it("keeps known and unknown values", () => {
    expect(mirrorEnum(["A", "B"], "B")).toEqual({ kind: "known", value: "B" });
    expect(mirrorEnum(["A", "B"], "C")).toEqual({ kind: "unrecognised", raw: "C" });
    expect(mirroredRaw({ kind: "unrecognised", raw: "C" })).toBe("C");
  });
});
