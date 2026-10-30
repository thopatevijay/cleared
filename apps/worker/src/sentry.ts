// Sentry for the worker (M1-08): `@sentry/node`, disabled when SENTRY_DSN is empty, no default PII,
// every event scrubbed by the shared `beforeSend`. DLQ arrivals and unhandled errors report through
// `reportError` (`@cleared/adapters`), never through the SDK directly.
import * as Sentry from "@sentry/node";
import { sentryOptions, setAlertSink } from "@cleared/adapters";

export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const options = sentryOptions({ service: "worker", env });
  Sentry.init(options);
  setAlertSink(options.enabled ? Sentry : undefined);
  return options.enabled;
}

/** Sends what is queued before the process exits (graceful stop). */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  await Sentry.flush(timeoutMs);
}
