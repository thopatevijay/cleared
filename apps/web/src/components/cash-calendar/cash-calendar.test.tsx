// M3-05 contract test: `CashCalendar` rendered from a props fixture (the engine-neutral interface) with the
// real EN/HI messages. The list view shows every event in its window with its title, grouped by day with
// the day's totals per currency; the month view is the client-only engine (only its loading state renders
// on the server); the text-alternative table lists every event in the range, each with its title.
import { CashCalendarResponseSchema, type CashCalendarResponse } from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { CashCalendar } from "./index.tsx";
import { CashTable, NoEstimate } from "./table.tsx";

const H = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = {
  url: "https://developer.paypal.com/docs/transaction-search/transaction-event-codes/",
  title: "PayPal transaction event codes: T2105 Payment review hold",
  quote: "PayPal reviews the transaction for up to 24 hours.",
  retrieved_at: "2026-10-26",
};

const FIXTURE: CashCalendarResponse = CashCalendarResponseSchema.parse({
  range: { from: "2026-11-01", to: "2027-01-31" },
  timezone: "Asia/Kolkata",
  events: [
    {
      id: `estimated_release:${H(1)}`,
      kind: "estimated_release",
      date: "2026-11-05",
      at: "2026-11-05T06:00:00.000Z",
      amount: { value: "64.00", currency: "USD" },
      estimated: true,
      ruleId: "payment_review",
      source,
      ref: { type: "hold", id: H(1) },
      detail: "PENDING_REVIEW",
    },
    {
      id: `released:${H(2)}`,
      kind: "released",
      date: "2026-11-06",
      at: "2026-11-06T06:00:00.000Z",
      amount: { value: "420.00", currency: "USD" },
      estimated: false,
      ruleId: null,
      source: null,
      ref: { type: "hold", id: H(2) },
      detail: "PENDING_REVIEW",
    },
    {
      id: `service_completed_due:${H(3)}`,
      kind: "service_completed_due",
      date: "2026-11-07",
      at: "2026-11-07T06:00:00.000Z",
      amount: { value: "80.00", currency: "USD" },
      estimated: true,
      ruleId: "service_completed",
      source,
      ref: { type: "hold", id: H(3) },
      detail: "OTHER",
    },
    {
      id: `dispute_deadline:${H(4)}`,
      kind: "dispute_deadline",
      date: "2026-11-09",
      at: "2026-11-09T06:00:00.000Z",
      amount: { value: "120.00", currency: "USD" },
      estimated: false,
      ruleId: null,
      source: null,
      ref: { type: "dispute", id: H(4) },
      detail: "WAITING_FOR_SELLER_RESPONSE",
    },
    // outside the list's first 30 days, inside the range: the table still lists it
    {
      id: `estimated_release:${H(5)}`,
      kind: "estimated_release",
      date: "2026-12-20",
      at: "2026-12-20T06:00:00.000Z",
      amount: { value: "15.50", currency: "EUR" },
      estimated: true,
      ruleId: "payment_review",
      source,
      ref: { type: "hold", id: H(5) },
      detail: "PENDING_REVIEW",
    },
  ],
  totals: [
    { date: "2026-11-05", currency: "USD", estimated: "64.00", released: "0", count: 1 },
    { date: "2026-11-06", currency: "USD", estimated: "0", released: "420.00", count: 1 },
    { date: "2026-11-07", currency: "USD", estimated: "80.00", released: "0", count: 1 },
    { date: "2026-12-20", currency: "EUR", estimated: "15.50", released: "0", count: 1 },
  ],
  heldNow: [{ value: "264.00", currency: "USD" }],
  noEstimate: [
    {
      holdId: H(6),
      amount: { value: "120.00", currency: "USD" },
      reason: "BUYER_COMPLAINT",
      ruleId: "dispute_hold",
    },
  ],
});

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const text = (m: string): string =>
  m
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const count = (m: string, testid: string): number => m.split(`data-testid="${testid}"`).length - 1;

const props = (view: "list" | "month", locale = "en-IN") => ({
  events: FIXTURE.events,
  totals: FIXTURE.totals,
  locale,
  tz: FIXTURE.timezone,
  view,
  initialDate: "2026-11-02",
  rangeEnd: FIXTURE.range.to,
  onSelect: () => undefined,
});

describe("CashCalendar contract (props fixture)", () => {
  it("list view: every event in the next 30 days, with its title, grouped by day with totals", () => {
    const out = html(<CashCalendar {...props("list")} />);
    expect(count(out, "cash-row")).toBe(4);
    expect(count(out, "cash-day")).toBe(4);
    const t = text(out);
    for (const title of [
      "$64.00 USD · estimated",
      "$420.00 USD released",
      "$80.00 USD · Completed + 7 days · estimated",
      "Reply due · $120.00 USD",
    ])
      expect(t).toContain(title);
    expect(t).not.toContain("€15.50");
    expect(t).toContain("$64.00 USD estimated");
    expect(t).toContain("Show next 30 days");
    // accessible names hold the visible label, then kind, estimated, date and source
    expect(out).toContain(
      'aria-label="$64.00 USD · estimated. 64.00 US dollars, estimated release, estimated, Thursday, 5 November, source PayPal transaction event codes: T2105 Payment review hold"',
    );
    expect(out).toContain('href="/en/disputes/' + H(4) + '"');
  });

  it("list view in Hindi uses the HI labels", () => {
    const t = text(html(<CashCalendar {...props("list", "hi-IN")} />, "hi"));
    expect(t).toContain("· अनुमानित");
    expect(t).toContain("जवाब की आख़िरी तारीख़");
  });

  it("month view renders only the engine's loading state on the server (client-only engine)", () => {
    const out = html(<CashCalendar {...props("month")} />);
    expect(count(out, "engine-loading")).toBe(1);
    expect(out).not.toContain("b-calendar");
  });

  it("the table lists every event in the range with its title; no estimate is listed apart", () => {
    const out = html(<CashTable data={FIXTURE} locale="en-IN" />);
    expect(count(out, "cash-table-row")).toBe(FIXTURE.events.length);
    expect(out).toContain("<caption");
    expect(out.match(/scope="col"/g)).toHaveLength(4);
    const t = text(out);
    expect(t).toContain("€15.50 EUR · estimated");
    expect(t).toContain("PayPal's date");
    expect(out).toMatch(/datetime="2026-12-20"/i);
    const none = text(html(<NoEstimate data={FIXTURE} locale="en-IN" />));
    expect(none).toContain("No estimate yet");
    expect(none).toContain("PayPal gives no timeline for this reason BUYER_COMPLAINT");
  });

  it("an empty range says so", () => {
    const out = html(<CashTable data={{ ...FIXTURE, events: [] }} locale="en-IN" />);
    expect(count(out, "cash-table-row")).toBe(0);
    expect(text(out)).toContain("Nothing in this range.");
  });
});
