// Next.js loads this file in the browser before the app (Next 15.3+). M4-04: the Sentry client init
// (sentry.client.config.ts, M1-08) is no longer in the first-load bundle: it loads once the page has
// loaded, off the critical path (about 55 KB gzip less on every page). Errors thrown before then are kept
// and sent once Sentry is up, so none are lost.
const early: unknown[] = [];
const onError = (e: ErrorEvent): void => {
  early.push(e.error ?? e.message);
};
const onRejection = (e: PromiseRejectionEvent): void => {
  early.push(e.reason);
};
addEventListener("error", onError);
addEventListener("unhandledrejection", onRejection);

function loadSentry(): void {
  void import("./sentry.client.config.ts").then(({ Sentry }) => {
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
    for (const err of early.splice(0)) Sentry.captureException(err);
  });
}

if (document.readyState === "complete") loadSentry();
else addEventListener("load", loadSentry, { once: true });
