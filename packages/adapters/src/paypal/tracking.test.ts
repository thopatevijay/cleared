import { describe, expect, it } from "vitest";
import { loadFixture } from "../testing/fixture.ts";
import { OrderSchema } from "./schemas.ts";
import { trackerFor, trackerId } from "./tracking.ts";

describe("trackerFor (M3-03 reconcile)", () => {
  const order = OrderSchema.parse(loadFixture("paypal/tracking/track-ind-delhivery").response.body);

  it("finds the recorded tracker by capture + tracking number", () => {
    expect(trackerId("6BC19320SY177903T", "SPKA1793249841084")).toBe("6BC19320SY177903T-SPKA1793249841084");
    expect(trackerFor(order, "6BC19320SY177903T", "SPKA1793249841084")?.status).toBe("SHIPPED");
  });

  it("is null for another tracking number or capture", () => {
    expect(trackerFor(order, "6BC19320SY177903T", "OTHER123")).toBeNull();
    expect(trackerFor(order, "NOPE", "SPKA1793249841084")).toBeNull();
  });
});
