// Minimal shared JSON logger (M1-03): pino with a `service` base and the current context's
// correlationId (and workspaceId/messageId when set) on every line. M1-08 adds redaction and Sentry.
import pino, { type DestinationStream, type Logger } from "pino";
import { currentContext } from "./context.ts";

export type { Logger } from "pino";

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  /** Where lines go; stdout by default. Tests pass a capturing stream. */
  readonly destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions): Logger {
  const options = {
    level: opts.level ?? process.env["LOG_LEVEL"] ?? "info",
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    mixin: () => {
      const ctx = currentContext();
      return ctx ? { ...ctx } : {};
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
