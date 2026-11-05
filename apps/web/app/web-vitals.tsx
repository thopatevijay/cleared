"use client";
// M4-04 field metrics: Next's `useReportWebVitals` hands each page's LCP, INP and CLS to the existing Sentry
// client (sentry.client.config.ts) as distribution metrics; no new vendor. Without a DSN
// the Sentry client is disabled and this records nothing. The route is reported as a pattern: ids and the
// acknowledgement token never leave the browser. Nothing is reported from the acknowledgement page, where
// the Sentry client never loads (BL-01 6649565909).
import { useReportWebVitals } from "next/web-vitals";
import { isAckPage } from "../src/lib/security-headers.ts";

type Reported = "LCP" | "INP" | "CLS";
const REPORTED: ReadonlySet<string> = new Set<Reported>(["LCP", "INP", "CLS"]);

/** `/en/holds/7c1e…` → `/en/holds/:id`: a segment with a digit, or longer than 24 characters, is an id. */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => (/\d/.test(s) || s.length > 24 ? ":id" : s))
    .join("/");
}

/** The fields we read from web-vitals' `Metric` (Next ships that library without its type declarations). */
interface VitalMetric {
  readonly name: string;
  readonly value: number;
  readonly rating: string;
  readonly navigationType: string;
}

export function WebVitals(): null {
  useReportWebVitals((metric: VitalMetric) => {
    if (!REPORTED.has(metric.name) || isAckPage(window.location.pathname)) return;
    const route = routePattern(window.location.pathname);
    // the Sentry client loads after the page (instrumentation-client.ts); this resolves to that module
    void import("../sentry.client.config.ts").then(({ Sentry }) => {
      Sentry.metrics.distribution(`web_vitals.${metric.name.toLowerCase()}`, metric.value, {
        unit: metric.name === "CLS" ? "none" : "millisecond",
        attributes: { route, rating: metric.rating, navigation: metric.navigationType },
      });
    });
  });
  return null;
}
