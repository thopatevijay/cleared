// Next.js server instrumentation (M1-08): Sentry and the web logger start once per server process.
// Errors thrown outside `withRoute` (pages, server components) reach Sentry through `onRequestError`.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    await import("./sentry.server.config.ts");
  }
}

export const onRequestError = Sentry.captureRequestError;
