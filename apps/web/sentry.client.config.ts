// Sentry in the browser (M1-08). The DSN is the build-time public copy of SENTRY_DSN (next.config.ts
// exposes it as NEXT_PUBLIC_SENTRY_DSN); empty → disabled. Nothing personal collected
// (`dataCollection`, Sentry 11's replacement for `sendDefaultPii: false`), no replay, no tracing.
// The browser bundle must not pull in node-only code, so the scrubbing here is self-contained.
import * as Sentry from "@sentry/nextjs";

// Dot access: Next inlines `process.env.NEXT_PUBLIC_*` only in this form.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const QUERY_SECRET = /([?&](?:[^=&]*(?:token|secret|code|key|sig|password)[^=&]*)=)[^&#]*/gi;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(QUERY_SECRET, "$1[Redacted]").replace(EMAIL, "[email]");
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /cookie|authorization|email|token/i.test(k) ? "[Redacted]" : scrub(v),
      ]),
    );
  }
  return value;
}

Sentry.init({
  dsn,
  enabled: dsn !== "",
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
  tracesSampleRate: 0,
  initialScope: { tags: { service: "web-client" } },
  beforeSend(event) {
    const rest = { ...event };
    delete rest.user;
    return scrub(rest) as typeof event;
  },
});

// M4-04: instrumentation-client.ts and app/web-vitals.tsx reach Sentry through this lazily loaded module.
export { Sentry };
