// M3-05: GET /api/cash-calendar over a seeded workspace with every kind (test/support/cash-seed.ts): a
// PENDING_REVIEW hold (estimated release, with its rule source), a BUYER_COMPLAINT hold + its dispute
// (a reply deadline; the hold itself has no timeline), a released hold and a confirmed service hold
// (Completed + 7 days). Totals are per day per currency. A foreign workspace's data is never returned;
// the range is validated (YYYY-MM-DD, `to` ≥ `from`, ≤ 92 days) and unauthenticated is 401.
import { CashCalendarResponseSchema, localDay } from "@cleared/core";
import { afterAll, describe, expect, it } from "vitest";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getCashCalendar } from "../../../src/server/handlers/cash-calendar.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { seedCash } from "../../../test/support/cash-seed.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";

const created: string[] = [];
const BASE = new Date("2026-11-04T12:00:00.000Z");

async function demo(): Promise<{ cookie: string; ws: string; tz: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const w = ((await res.json()) as { workspace: { id: string; timezone: string } }).workspace;
  created.push(w.id);
  return { cookie, ws: w.id, tz: w.timezone };
}

const get = async (cookie: string | undefined, query: string, now = new Date("2026-11-02T06:00:00Z")) => {
  const res = await getCashCalendar(
    req(`/api/cash-calendar${query}`, { method: "GET", ...(cookie === undefined ? {} : { cookie }) }),
    testDeps({ now: () => now }),
  );
  return { status: res.status, body: (await res.json()) as unknown };
};

describe.skipIf(!dbAvailable)("cash calendar API (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
  });

  it("returns every kind with per-day per-currency totals; a foreign workspace sees none of it", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedCash(testDb(), a.ws, BASE);
    // b has its own hold, which a must never see
    await seedCash(testDb(), b.ws, BASE);

    const res = await get(a.cookie, "?from=2026-11-01&to=2026-11-30");
    expect(res.status).toBe(200);
    const c = CashCalendarResponseSchema.parse(res.body);
    expect(c.range).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(c.timezone).toBe(a.tz);
    const day = (d: Date) => localDay(d.toISOString(), a.tz);
    expect(c.events.map((e) => [e.kind, e.ref.id, e.date, e.amount, e.estimated])).toEqual([
      ["released", s.released.holdId, day(s.released.at), { value: "420.00", currency: "USD" }, false],
      [
        "estimated_release",
        expect.any(String),
        day(s.review.estimate),
        { value: "15.50", currency: "EUR" },
        true,
      ],
      [
        "estimated_release",
        expect.any(String),
        day(s.review.estimate),
        { value: "64.00", currency: "USD" },
        true,
      ],
      [
        "service_completed_due",
        s.service.holdId,
        day(s.service.estimate),
        { value: "80.00", currency: "USD" },
        true,
      ],
      [
        "dispute_deadline",
        s.complaint.disputeRowId,
        day(s.complaint.due),
        { value: "120.00", currency: "USD" },
        false,
      ],
    ]);
    expect(new Set(c.events.slice(1, 3).map((e) => e.ref.id))).toEqual(
      new Set([s.review.holdId, s.reviewEur.holdId]),
    );
    const review = c.events.find((e) => e.ref.id === s.review.holdId);
    expect(review).toMatchObject({
      ruleId: "payment_review",
      at: s.review.estimate.toISOString(),
      detail: "PENDING_REVIEW",
      ref: { type: "hold" },
    });
    expect(review?.source?.url).toMatch(/^https:\/\//);
    expect(c.events.find((e) => e.kind === "service_completed_due")?.ruleId).toBe("service_completed");
    expect(c.events.find((e) => e.kind === "dispute_deadline")).toMatchObject({
      ref: { type: "dispute" },
      detail: "WAITING_FOR_SELLER_RESPONSE",
      at: s.complaint.due.toISOString(),
    });

    expect(c.totals).toEqual([
      { date: day(s.released.at), currency: "USD", estimated: "0", released: "420.00", count: 1 },
      { date: day(s.review.estimate), currency: "EUR", estimated: "15.50", released: "0", count: 1 },
      { date: day(s.review.estimate), currency: "USD", estimated: "64.00", released: "0", count: 1 },
      { date: day(s.service.estimate), currency: "USD", estimated: "80.00", released: "0", count: 1 },
    ]);
    // held now: review + complaint + service (USD), the EUR review; never summed across currencies
    expect(c.heldNow).toEqual([
      { value: "15.50", currency: "EUR" },
      { value: "264.00", currency: "USD" },
    ]);
    expect(c.noEstimate).toEqual([
      {
        holdId: s.complaint.holdId,
        amount: { value: "120.00", currency: "USD" },
        reason: "BUYER_COMPLAINT",
        ruleId: "dispute_hold",
      },
    ]);

    // b's own calendar has the same shape but none of a's ids
    const theirs = CashCalendarResponseSchema.parse(
      (await get(b.cookie, "?from=2026-11-01&to=2026-11-30")).body,
    );
    const mine = new Set(c.events.map((e) => e.ref.id));
    expect(theirs.events).toHaveLength(5);
    expect(theirs.events.some((e) => mine.has(e.ref.id))).toBe(false);
    expect(theirs.noEstimate.some((n) => n.holdId === s.complaint.holdId)).toBe(false);
  });

  it("a range outside the events is empty; the default is this month (workspace zone) + 92 days", async () => {
    const a = await demo();
    await seedCash(testDb(), a.ws, BASE);
    const dec = CashCalendarResponseSchema.parse(
      (await get(a.cookie, "?from=2026-12-01&to=2026-12-31")).body,
    );
    expect(dec.events).toEqual([]);
    expect(dec.totals).toEqual([]);
    expect(dec.heldNow).toHaveLength(2);
    const def = CashCalendarResponseSchema.parse((await get(a.cookie, "")).body);
    expect(def.range).toEqual({ from: "2026-11-01", to: "2027-01-31" });
    expect(def.events).toHaveLength(5);
  });

  it("validates the range; unauthenticated is 401", async () => {
    const a = await demo();
    for (const q of [
      "?from=2026-11-01",
      "?from=2026-11-01&to=2027-02-01",
      "?from=2026-11-02&to=2026-11-01",
      "?from=2026-11-01T00:00:00Z&to=2026-11-02",
      "?from=2026-11-01&to=2026-11-02&ws=x",
    ]) {
      const r = await get(a.cookie, q);
      expect(r.status, q).toBe(400);
      expect(r.body).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect((await get(a.cookie, "?from=2026-11-01&to=2027-01-31")).status).toBe(200);
    expect((await get(undefined, "?from=2026-11-01&to=2026-11-30")).status).toBe(401);
  });
});
