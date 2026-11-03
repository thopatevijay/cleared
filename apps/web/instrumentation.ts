// Next.js server instrumentation (M1-08): Sentry and the web logger start once per server process.
// Errors thrown outside `withRoute` (pages, server components) reach Sentry through `onRequestError`.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    // M4-06: the webhook test signing harness outside NODE_ENV=test stops the boot
    const { assertTestSigningAllowed } = await import("./src/server/test-signing.ts");
    assertTestSigningAllowed(process.env);
    await import("./sentry.server.config.ts");
  }
}

export const onRequestError = Sentry.captureRequestError;
