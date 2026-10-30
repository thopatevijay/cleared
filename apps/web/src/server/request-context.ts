// Request context for the web (M1-08): the correlation id of a request and the web's logger.
// An inbound `x-correlation-id` is accepted only when it is a UUID (anything else, e.g. `<script>`, is
// replaced by a fresh one), so a caller can't inject text into our logs or error envelopes.
import { randomUUID } from "node:crypto";
import { createLogger, currentContext, setProcessLogger, type Logger } from "@cleared/adapters";

export const CORRELATION_HEADER = "x-correlation-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The inbound id when it is a UUID (lower-cased), else a new UUID. */
export function resolveCorrelationId(inbound: string | null | undefined): string {
  const value = inbound?.trim() ?? "";
  return UUID.test(value) ? value.toLowerCase() : randomUUID();
}

/** The id `withRoute` set for this request; outside one, the header's (validated) or a new one. */
export function requestCorrelationId(req?: Request): string {
  return currentContext()?.correlationId ?? resolveCorrelationId(req?.headers.get(CORRELATION_HEADER));
}

let logger: Logger | undefined;

/** The web's logger (`service: "web"`); it also becomes the process logger the HTTP client uses. */
export function webLogger(): Logger {
  if (logger === undefined) {
    logger = createLogger({ service: "web" });
    setProcessLogger(logger);
  }
  return logger;
}
