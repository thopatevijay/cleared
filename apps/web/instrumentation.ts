// Next.js server instrumentation (M1-08): Sentry and the web logger start once per server process.
// Errors thrown outside `withRoute` (pages, server components) reach Sentry through `onRequestError`.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    // M4-06: the webhook test signing harness outside NODE_ENV=test stops the boot
    const { assertTestSigningAllowed } = await import("./src/server/test-signing.ts");
    assertTestSigningAllowed(process.env);
    await import("./sentry.server.config.ts");
    // BL-01 6609550494: load the route chunks before the first real requests (not awaited: it runs once the
    // server listens)
    const { warmUp, warmUpUrl } = await import("./src/server/warm-up.ts");
    const url = warmUpUrl(process.env);
    if (url !== null) void warmUp(url);
  }
}

export const onRequestError = Sentry.captureRequestError;
