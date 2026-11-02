// M3-04 AC 1 (core side): the seller's web-step confirmation sets the estimate to the confirmed date + 7 days
// with `estimate_source = service_completed` (help129 quote + url) and walks the hold to `filed`; the date
// rules; the Activity host per PAYPAL_ENV; the secondary payload (strict, carrier OTHER, no tracking number).
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../agent/canonical-hash.ts";
import { checkApproval, parseExecutablePayload } from "../actions/policy.ts";
import { parseInstant, type Instant } from "../time.ts";
import {
  completedRecordState,
  confirmServiceCompleted,
  localDate,
  localNoon,
  PAYPAL_SUPPORT_QUOTES,
  paypalActivityUrl,
  recordServiceCompletedPayload,
  RecordServiceCompletedPayloadSchema,
  walkToFiled,
  type CompletedHoldFacts,
} from "./completed.ts";
import { ESTIMATE_LABEL, holdRule } from "./rules.ts";

function at(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
}

const hold = (o: Partial<CompletedHoldFacts> = {}): CompletedHoldFacts => ({
  type: "service",
  state: "open",
  openedAt: at("2026-10-28T09:00:00.000Z"),
  completedConfirmedAt: null,
  ...o,
});
const NOW = at("2026-11-02T10:00:00.000Z");
const confirm = (o: Partial<Parameters<typeof confirmServiceCompleted>[0]> = {}) =>
  confirmServiceCompleted({ hold: hold(), confirmedOn: "2026-11-02", now: NOW, timeZone: "UTC", ...o });

describe("confirmServiceCompleted (M3-04 AC 1)", () => {
  it("today → now + 7 days, rule service_completed with the help129 quote + url, labelled estimated", () => {
    const r = confirm();
    if (!r.ok) throw new Error(r.error);
    expect(r.value.confirmedAt).toBe(NOW);
    expect(r.value.estimate.at).toBe("2026-11-09T10:00:00.000Z");
    expect(r.value.estimate.label).toBe(ESTIMATE_LABEL);
    expect(r.value.ruleId).toBe("service_completed");
    const src = holdRule(r.value.ruleId)?.sources[0];
    expect(src?.quote).toBe("We'll release the hold 7 days after you confirm the order status as Completed.");
    expect(src?.url).toContain("help129");
  });

  it("an earlier day → noon that day in the workspace zone + 7 days", () => {
    const r = confirm({ confirmedOn: "2026-10-30", timeZone: "Asia/Kolkata" });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.confirmedAt).toBe("2026-10-30T06:30:00.000Z"); // 12:00 IST
    expect(r.value.estimate.at).toBe("2026-11-06T06:30:00.000Z");
  });

  it("the day the hold opened never yields a confirmation before the opening", () => {
    const opened = at("2026-10-28T15:00:00.000Z");
    const r = confirm({ hold: hold({ openedAt: opened }), confirmedOn: "2026-10-28" });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.confirmedAt).toBe(opened);
  });

  it("walks every confirmable state to filed (the M3-01 machine)", () => {
    for (const state of ["open", "explained", "action_proposed", "approved"] as const) {
      const r = confirm({ hold: hold({ state }) });
      expect(r.ok && r.value.state).toBe("filed");
    }
    expect(walkToFiled("filed")).toBe("filed");
  });

  it("refuses: not a service hold, already confirmed, released / filed / still held, bad dates", () => {
    expect(confirm({ hold: hold({ type: "goods" }) })).toEqual({ ok: false, error: "NOT_SERVICE_HOLD" });
    expect(confirm({ hold: hold({ completedConfirmedAt: NOW }) })).toEqual({
      ok: false,
      error: "ALREADY_CONFIRMED",
    });
    for (const state of ["released", "filed", "still_held"] as const) {
      expect(confirm({ hold: hold({ state }) })).toEqual({ ok: false, error: "NOT_CONFIRMABLE" });
    }
    expect(confirm({ confirmedOn: "2026-11-03" })).toEqual({ ok: false, error: "DATE_IN_FUTURE" });
    expect(confirm({ confirmedOn: "2026-10-27" })).toEqual({ ok: false, error: "DATE_BEFORE_HOLD" });
    expect(confirm({ confirmedOn: "2026-13-01" })).toEqual({ ok: false, error: "INVALID_DATE" });
    expect(confirm({ confirmedOn: "yesterday" })).toEqual({ ok: false, error: "INVALID_DATE" });
  });

  it("'today' follows the workspace zone, not UTC", () => {
    // 2026-11-02T20:00Z is already 3 Nov in Kolkata
    const late = at("2026-11-02T20:00:00.000Z");
    expect(confirm({ now: late, confirmedOn: "2026-11-03", timeZone: "Asia/Kolkata" }).ok).toBe(true);
    expect(confirm({ now: late, confirmedOn: "2026-11-03", timeZone: "UTC" })).toEqual({
      ok: false,
      error: "DATE_IN_FUTURE",
    });
  });
});

describe("zone helpers", () => {
  it("localDate / localNoon round-trip across zones and DST", () => {
    expect(localDate(at("2026-11-02T20:00:00.000Z"), "Asia/Kolkata")).toBe("2026-11-03");
    expect(localNoon("2026-07-01", "America/Los_Angeles")).toBe("2026-07-01T19:00:00.000Z"); // PDT
    expect(localNoon("2026-12-01", "America/Los_Angeles")).toBe("2026-12-01T20:00:00.000Z"); // PST
  });
});

describe("PayPal Activity link (M3-04 AC 4, core side)", () => {
  it("the host follows PAYPAL_ENV", () => {
    expect(new URL(paypalActivityUrl("sandbox")).host).toBe("www.sandbox.paypal.com");
    expect(new URL(paypalActivityUrl("live")).host).toBe("www.paypal.com");
  });

  it("carries PayPal support's two quotes with their date", () => {
    expect(PAYPAL_SUPPORT_QUOTES.webPath.quote).toContain('"Completed" in your Activity section');
    expect(PAYPAL_SUPPORT_QUOTES.apiUnconfirmed.quote).toContain("is not available");
    expect(PAYPAL_SUPPORT_QUOTES.webPath.date).toBe("2026-10-26");
  });
});

describe("record_service_completed payload (secondary)", () => {
  const payload = recordServiceCompletedPayload("7AS90958XD7569923");

  it("is the capture, status COMPLETED, carrier OTHER and no tracking number", () => {
    expect(payload).toEqual({ capture_id: "7AS90958XD7569923", status: "COMPLETED", carrier: "OTHER" });
    expect(RecordServiceCompletedPayloadSchema.safeParse({ ...payload, tracking_number: "X1" }).success).toBe(
      false,
    );
    expect(RecordServiceCompletedPayloadSchema.safeParse({ ...payload, status: "SHIPPED" }).success).toBe(false);
  });

  it("is executable, and its approval binds the payload hash", () => {
    expect(parseExecutablePayload("record_service_completed", payload)?.kind).toBe("record_service_completed");
    const subject = {
      kind: "record_service_completed",
      state: "proposed" as const,
      payload,
      payloadSha256: canonicalHash(payload),
      createdByRunId: null,
    };
    expect(checkApproval(subject, { payloadSha256: subject.payloadSha256 }).kind).toBe("allow");
    expect(checkApproval(subject, { payloadSha256: canonicalHash({ ...payload, capture_id: "X" }) })).toEqual({
      kind: "refuse",
      code: "APPROVAL_HASH_MISMATCH",
    });
  });

  it("maps action states onto the card's record state", () => {
    expect(completedRecordState(null)).toBe("none");
    expect(completedRecordState("rejected")).toBe("none");
    expect(completedRecordState("executing")).toBe("recording");
    expect(completedRecordState("succeeded")).toBe("recorded");
    expect(completedRecordState("unknown")).toBe("unknown");
  });
});
