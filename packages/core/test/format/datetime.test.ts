// M4-03 AC 4: deadlines in the workspace's IANA zone (UTC in the tooltip), in the seller zones Cleared
// serves plus a DST change (America/Los_Angeles falls back on 2026-11-01 at 02:00 PDT), and the T-72 h /
// T-24 h countdowns in each zone.
import { describe, expect, it } from "vitest";
import {
  canonicalTimeZone,
  formatDateTime,
  formatRelative,
  formatUtc,
  relativeParts,
} from "../../src/index.ts";

/** A dispute's seller_response_due_date (UTC), as PayPal sends it. */
const DUE = "2026-11-02T17:00:00.000Z";
const DUE_MS = Date.parse(DUE);
const T72 = new Date(DUE_MS - 72 * 3_600_000).toISOString(); // 2026-10-30T17:00Z
const T24 = new Date(DUE_MS - 24 * 3_600_000).toISOString(); // 2026-11-01T17:00Z

interface ZoneRow {
  readonly zone: string;
  /** the deadline, T-72 h and T-24 h on the zone's wall clock (en-IN, then hi-IN) */
  readonly en: readonly [due: string, t72: string, t24: string];
  readonly hi: readonly [due: string, t72: string, t24: string];
}

const ZONES: readonly ZoneRow[] = [
  {
    zone: "Asia/Kolkata",
    en: ["2 Nov 2026, 10:30 pm IST", "30 Oct 2026, 10:30 pm IST", "1 Nov 2026, 10:30 pm IST"],
    hi: ["2 नव॰ 2026, 22:30 IST", "30 अक्टू॰ 2026, 22:30 IST", "1 नव॰ 2026, 22:30 IST"],
  },
  {
    zone: "Africa/Lagos",
    en: ["2 Nov 2026, 6:00 pm GMT+1", "30 Oct 2026, 6:00 pm GMT+1", "1 Nov 2026, 6:00 pm GMT+1"],
    hi: ["2 नव॰ 2026, 18:00 GMT+1", "30 अक्टू॰ 2026, 18:00 GMT+1", "1 नव॰ 2026, 18:00 GMT+1"],
  },
  {
    zone: "Africa/Nairobi",
    en: ["2 Nov 2026, 8:00 pm GMT+3", "30 Oct 2026, 8:00 pm GMT+3", "1 Nov 2026, 8:00 pm GMT+3"],
    hi: ["2 नव॰ 2026, 20:00 GMT+3", "30 अक्टू॰ 2026, 20:00 GMT+3", "1 नव॰ 2026, 20:00 GMT+3"],
  },
  {
    zone: "Asia/Jakarta",
    en: ["3 Nov 2026, 12:00 am GMT+7", "31 Oct 2026, 12:00 am GMT+7", "2 Nov 2026, 12:00 am GMT+7"],
    hi: ["3 नव॰ 2026, 00:00 GMT+7", "31 अक्टू॰ 2026, 00:00 GMT+7", "2 नव॰ 2026, 00:00 GMT+7"],
  },
  {
    // DST ends between T-72 h (PDT, GMT-7) and T-24 h (PST, GMT-8): same UTC hour, wall clock moves back 1 h
    zone: "America/Los_Angeles",
    en: ["2 Nov 2026, 9:00 am GMT-8", "30 Oct 2026, 10:00 am GMT-7", "1 Nov 2026, 9:00 am GMT-8"],
    hi: ["2 नव॰ 2026, 09:00 GMT-8", "30 अक्टू॰ 2026, 10:00 GMT-7", "1 नव॰ 2026, 09:00 GMT-8"],
  },
];

describe("formatDateTime", () => {
  for (const row of ZONES) {
    it(`${row.zone}: the deadline and its T-72 h / T-24 h marks on the local wall clock`, () => {
      for (const [locale, want] of [
        ["en-IN", row.en],
        ["hi-IN", row.hi],
      ] as const) {
        expect([DUE, T72, T24].map((iso) => formatDateTime(iso, row.zone, locale))).toEqual(want);
      }
    });

    it(`${row.zone}: T-72 h reads "in 3 days", T-24 h "in 1 day", wherever the seller is`, () => {
      expect(formatRelative(DUE, Date.parse(T72), "en-IN")).toBe("in 3 days");
      expect(formatRelative(DUE, Date.parse(T24), "en-IN")).toBe("in 1 day");
      expect(formatRelative(DUE, Date.parse(T72), "hi-IN")).toBe("3 दिन में");
      expect(formatRelative(DUE, Date.parse(T24), "hi-IN")).toBe("1 दिन में");
    });
  }

  it("America/Los_Angeles on 2026-11-01: 01:30 happens twice, once in PDT and once in PST", () => {
    expect(formatDateTime("2026-11-01T08:30:00.000Z", "America/Los_Angeles", "en-US")).toBe(
      "Nov 1, 2026, 1:30 AM PDT",
    );
    expect(formatDateTime("2026-11-01T09:30:00.000Z", "America/Los_Angeles", "en-US")).toBe(
      "Nov 1, 2026, 1:30 AM PST",
    );
  });

  it("Hindi uses the 24-hour clock: no Latin am/pm inside Devanagari (BL-01 6569282428)", () => {
    const s = formatDateTime(DUE, "Asia/Kolkata", "hi-IN-u-nu-latn");
    expect(s).toBe("2 नव॰ 2026, 22:30 IST");
    expect(s).not.toMatch(/am|pm/i);
  });

  it("an unknown zone falls back to UTC rather than throwing", () => {
    expect(formatDateTime(DUE, "Mars/Olympus", "en-IN")).toBe("2 Nov 2026, 5:00 pm UTC");
  });

  it("formatUtc gives the tooltip's UTC time", () => {
    expect(formatUtc(DUE, "en-IN")).toBe("2 Nov 2026, 5:00 pm UTC");
    expect(formatUtc(DUE, "hi-IN")).toBe("2 नव॰ 2026, 17:00 UTC");
  });
});

describe("formatRelative", () => {
  it("counts whole days from 24 h, whole hours below, and the past as ago", () => {
    expect(relativeParts(DUE, DUE_MS - 47 * 3_600_000)).toEqual({ unit: "day", n: 1 });
    expect(relativeParts(DUE, DUE_MS - 23.9 * 3_600_000)).toEqual({ unit: "hour", n: 23 });
    expect(formatRelative(DUE, DUE_MS - 5 * 3_600_000, "en-IN")).toBe("in 5 hours");
    expect(formatRelative(DUE, DUE_MS + 2 * 3_600_000, "en-IN")).toBe("2 hours ago");
    expect(formatRelative(DUE, DUE_MS + 2 * 3_600_000, "hi-IN")).toBe("2 घंटे पहले");
  });
});

describe("canonicalTimeZone", () => {
  it("maps the legacy names browsers still report to current IANA names", () => {
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTimeZone("Africa/Lagos")).toBe("Africa/Lagos");
    // the mapped name formats exactly as the alias did
    expect(formatDateTime(DUE, "Asia/Kolkata", "en-IN")).toBe(formatDateTime(DUE, "Asia/Calcutta", "en-IN"));
  });
});
