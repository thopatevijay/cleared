// M2-10 AC "re-delivering any step job makes no second chargeback call": the chargeback lists the
// capture's disputes first and adopts an existing one. The PayPal bodies are the recorded M0-05 ones.
import { describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../testing/fixture.ts";
import { openScenarioChargeback } from "./chargeback.ts";
import type { ChargebackInput, ListDisputesQuery } from "./disputes.ts";
import { DisputeListSchema, type DisputeList } from "./disputes.schemas.ts";

const recordedList = DisputeListSchema.parse(
  JSON.parse(responseText(loadFixture("paypal/disputes/list/update-time-after"))),
);
const recordedChargeback = JSON.parse(responseText(loadFixture("paypal/disputes/full/chargeback"))) as {
  dispute_id: string;
};

function fakeDisputes(list: DisputeList) {
  const calls: { list: ListDisputesQuery[]; chargeback: ChargebackInput[] } = { list: [], chargeback: [] };
  return {
    calls,
    client: {
      listDisputes: (q?: ListDisputesQuery) => {
        calls.list.push(q ?? {});
        return Promise.resolve(list);
      },
      processChargeback: (input: ChargebackInput) => {
        calls.chargeback.push(input);
        return Promise.resolve(recordedChargeback);
      },
    },
  };
}

const input = {
  captureId: "794390931G848631R",
  amount: { currency_code: "USD", value: "120.00" },
  merchantId: "MERCHANT-1",
  requestId: "run-1-chargeback",
};

describe("openScenarioChargeback", () => {
  it("files the chargeback when the capture has no dispute yet", async () => {
    const f = fakeDisputes({ items: [] });
    const out = await openScenarioChargeback(f.client, input);
    expect(out).toEqual({ disputeId: recordedChargeback.dispute_id, adopted: false });
    expect(f.calls.list).toEqual([{ disputedTransactionId: input.captureId }]);
    expect(f.calls.chargeback).toHaveLength(1);
    expect(f.calls.chargeback[0]).toMatchObject({
      captureId: input.captureId,
      requestId: "run-1-chargeback",
    });
  });

  it("adopts an existing dispute on the capture and never files a second chargeback", async () => {
    const existing = recordedList.items[0];
    expect(existing).toBeDefined();
    const f = fakeDisputes({ items: existing ? [existing] : [] });
    const out = await openScenarioChargeback(f.client, input);
    expect(out).toEqual({ disputeId: existing?.dispute_id, adopted: true });
    expect(f.calls.chargeback).toHaveLength(0);
  });
});
