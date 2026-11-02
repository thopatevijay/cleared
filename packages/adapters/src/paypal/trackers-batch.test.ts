// M3-04: reading the recorded M0-04 trackers-batch answer and the NOTRACKER read-back.
import { describe, expect, it } from "vitest";
import { loadFixture } from "../testing/fixture.ts";
import { HttpStatusError } from "../http/errors.ts";
import { TrackersBatchResponseSchema, LegacyTrackerSchema } from "./schemas.ts";
import { completedBatchOutcome, noTrackerId, readBackCompleted } from "./trackers-batch.ts";

const batch = TrackersBatchResponseSchema.parse(
  loadFixture("paypal/tracking/trackers-batch-completed").response.body,
);
const CAPTURE = "7AS90958XD7569923";

describe("trackers-batch (M3-04)", () => {
  it("the recorded 200 lists the capture with no errors → accepted", () => {
    expect(completedBatchOutcome(batch, CAPTURE)).toEqual({ accepted: true, errors: [] });
    expect(completedBatchOutcome(batch, "OTHERCAPTURE").accepted).toBe(false);
  });

  it("a 200 with per-tracker errors is not accepted", () => {
    const failed = { ...batch, errors: [{ name: "INVALID_REQUEST" }] };
    expect(completedBatchOutcome(failed, CAPTURE)).toEqual({ accepted: false, errors: ["INVALID_REQUEST"] });
  });

  it("the read-back id and status", async () => {
    expect(noTrackerId(CAPTURE)).toBe(`${CAPTURE}-NOTRACKER`);
    const t = LegacyTrackerSchema.parse(loadFixture("paypal/tracking/get-legacy-tracker").response.body);
    expect(await readBackCompleted({ getLegacyTracker: () => Promise.resolve(t) }, CAPTURE)).toEqual({
      landed: true,
      status: "COMPLETED",
    });
  });

  it("a 404 read-back → not landed; any other error throws", async () => {
    const e = (status: number) =>
      new HttpStatusError("paypal", "GET", "https://x", status, "{}", {}, undefined);
    expect(await readBackCompleted({ getLegacyTracker: () => Promise.reject(e(404)) }, CAPTURE)).toEqual({
      landed: false,
      status: null,
    });
    await expect(
      readBackCompleted({ getLegacyTracker: () => Promise.reject(e(500)) }, CAPTURE),
    ).rejects.toThrow();
  });
});
