import { describe, expect, it } from "vitest";
import {
  PAYMENTS_PAGE_MAX,
  PaymentItemSchema,
  PaymentsQuerySchema,
  PaymentsResponseSchema,
} from "../src/index.ts";

describe("payments contract (M1-07)", () => {
  it("defaults the page and coerces query strings", () => {
    expect(PaymentsQuerySchema.parse({})).toEqual({ offset: 0, limit: PAYMENTS_PAGE_MAX });
    expect(PaymentsQuerySchema.parse({ offset: "10", limit: "5" })).toEqual({ offset: 10, limit: 5 });
    expect(PaymentsQuerySchema.parse({ offset: null, limit: "" })).toEqual({ offset: 0, limit: 50 });
  });

  it.each([{ limit: "51" }, { limit: "0" }, { offset: "-1" }, { offset: "1.5" }, { limit: "x" }])(
    "refuses %o",
    (q) => {
      expect(PaymentsQuerySchema.safeParse(q).success).toBe(false);
    },
  );

  it("keeps PayPal values verbatim (an unknown status still parses)", () => {
    const item = {
      id: "6f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b",
      captureId: "2FB27654CR016344S",
      amount: { value: "42.00", currency: "USD" },
      receivable: null,
      status: "SOMETHING_NEW",
      statusReason: null,
      source: "webhook",
      updatedAt: "2026-10-30T10:00:00.000Z",
      pack: null,
      // M3-01: the active derived hold (null: PayPal holds nothing on this capture)
      hold: null,
    };
    expect(PaymentItemSchema.parse(item)).toEqual(item);
    expect(PaymentItemSchema.safeParse({ ...item, amount: { value: "4,2", currency: "USD" } }).success).toBe(
      false,
    );
  });

  it("the summary has no dispute figure yet; proof-ready is a count (M2-05)", () => {
    const body = {
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
      summary: { held: [], inDispute: null, proofReady: 0 },
      workspace: { kind: "demo", timezone: "UTC" },
      testPayments: { waiting: 0, usedToday: 0, limit: 3 },
    };
    expect(PaymentsResponseSchema.parse(body)).toEqual(body);
    expect(
      PaymentsResponseSchema.safeParse({ ...body, summary: { ...body.summary, inDispute: 1 } }).success,
    ).toBe(false);
  });
});
