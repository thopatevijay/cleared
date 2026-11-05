// Next.js loads this file in the browser before the app (Next 15.3+). M4-04: the Sentry client init
// (sentry.client.config.ts, M1-08) is no longer in the first-load bundle: it loads once the page has
// loaded, off the critical path (about 55 KB gzip less on every page). Errors thrown before then are kept
// and sent once Sentry is up, so none are lost.
// BL-01 6649565909: not on the public acknowledgement page, whose CSP allows no third-party connection
// (the token is in its URL); see isAckPage in src/lib/security-headers.ts.
import { isAckPage } from "./src/lib/security-headers.ts";

const early: unknown[] = [];
const onError = (e: ErrorEvent): void => {
  early.push(e.error ?? e.message);
};
const onRejection = (e: PromiseRejectionEvent): void => {
  early.push(e.reason);
};

function loadSentry(): void {
  void import("./sentry.client.config.ts").then(({ Sentry }) => {
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
    for (const err of early.splice(0)) Sentry.captureException(err);
  });
}

if (!isAckPage(location.pathname)) {
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  if (document.readyState === "complete") loadSentry();
  else addEventListener("load", loadSentry, { once: true });
}
