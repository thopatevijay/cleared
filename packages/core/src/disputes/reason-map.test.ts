// M2-07 AC 1: the reason map as a table, plus PayPal's requested evidence types (the recorded M0-05 dispute).
import { describe, expect, it } from "vitest";
import { recordedDispute } from "../../test/helpers/dispute-fixtures.ts";
import { filingKindFor, mapReason, requestedEvidenceTypes } from "./reason-map.ts";

const NOT_RECEIVED = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const NOT_AS_DESCRIBED = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";

/** The M0-05 sandbox dispute in WAITING_FOR_SELLER_RESPONSE (fixtures/paypal/disputes/full). */
const waiting = { response: { body: recordedDispute("state-3-waiting_for_seller_response") } };

describe("reason map (M2-07 AC 1)", () => {
  it.each([
    [NOT_RECEIVED, "PROOF_OF_FULFILLMENT", "reason_table", false, ["delivery_events", "shipment"]],
    [NOT_AS_DESCRIBED, "OTHER", "reason_table", false, ["scope_verdicts", "acceptance"]],
    [
      "UNAUTHORISED",
      "OTHER",
      "default",
      true,
      ["delivery_events", "shipment", "scope_verdicts", "acceptance"],
    ],
    [null, "OTHER", "default", true, ["delivery_events", "shipment", "scope_verdicts", "acceptance"]],
  ] as const)("%s → %s (%s, unmapped=%s)", (reason, type, source, unmapped, focus) => {
    expect(mapReason(reason, [])).toEqual({
      evidenceType: type,
      source,
      reasonUnmapped: unmapped,
      focus,
    });
  });

  it("the recorded M0-05 dispute: PayPal requests PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER (seller)", () => {
    const body = waiting.response.body;
    expect(body.reason).toBe(NOT_AS_DESCRIBED);
    expect(requestedEvidenceTypes(body.evidences)).toEqual([
      "PROOF_OF_FULFILLMENT",
      "PROOF_OF_REFUND",
      "OTHER",
    ]);
  });

  it("PayPal's request wins over the table for both mapped reasons (and keeps the reason's focus)", () => {
    const requested = requestedEvidenceTypes(waiting.response.body.evidences);
    // not-as-described: the table says OTHER, PayPal's first draftable request is PROOF_OF_FULFILLMENT
    expect(mapReason(NOT_AS_DESCRIBED, requested)).toEqual({
      evidenceType: "PROOF_OF_FULFILLMENT",
      source: "paypal_request",
      reasonUnmapped: false,
      focus: ["scope_verdicts", "acceptance"],
    });
    expect(mapReason(NOT_RECEIVED, requested)).toMatchObject({
      evidenceType: "PROOF_OF_FULFILLMENT",
      source: "paypal_request",
    });
    // not-received: a request for OTHER only overrides the table's PROOF_OF_FULFILLMENT
    expect(mapReason(NOT_RECEIVED, ["OTHER"])).toMatchObject({
      evidenceType: "OTHER",
      source: "paypal_request",
    });
    // an unknown reason still says it is unmapped
    expect(mapReason("SOMETHING_NEW", requested)).toMatchObject({
      evidenceType: "PROOF_OF_FULFILLMENT",
      reasonUnmapped: true,
    });
  });

  it("PROOF_OF_REFUND alone is never drafted; buyer-side and submitted entries are not requests", () => {
    expect(mapReason(NOT_RECEIVED, ["PROOF_OF_REFUND"])).toMatchObject({
      evidenceType: "PROOF_OF_FULFILLMENT",
      source: "reason_table",
    });
    expect(
      requestedEvidenceTypes([
        { evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER" },
        { evidence_type: "OTHER", source: "SUBMITTED_BY_SELLER" },
        { evidence_type: "PROOF_OF_SHIPMENT", source: "REQUESTED_FROM_BUYER" },
        { evidence_type: "bad type", source: "REQUESTED_FROM_SELLER" },
        { evidence_type: "OTHER", source: "REQUESTED_FROM_SELLER" },
        { evidence_type: "OTHER", source: "REQUESTED_FROM_SELLER" },
      ]),
    ).toEqual(["OTHER"]);
    expect(requestedEvidenceTypes(undefined)).toEqual([]);
  });

  it("the filing kind comes from the dispute's links: provide_evidence preferred, else supporting info", () => {
    expect(filingKindFor(["accept_claim", "provide_evidence"])).toBe("provide_evidence");
    expect(filingKindFor(["provide_evidence", "provide_supporting_info"])).toBe("provide_evidence");
    expect(filingKindFor(["provide_supporting_info"])).toBe("provide_supporting_info");
    expect(filingKindFor(["accept_claim"])).toBeNull();
    expect(filingKindFor([])).toBeNull();
  });
});
