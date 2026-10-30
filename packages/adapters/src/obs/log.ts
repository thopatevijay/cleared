// The shared JSON logger (M1-03, extended in M1-08). Every line carries `service` (`web` | `worker`),
// `env`, `release` (the Render git commit when present) and the current context's correlationId (plus
// workspaceId/messageId when set). Every line is redacted (`redact.ts`) before it is written.
import pino, { type DestinationStream, type Logger } from "pino";
import { currentContext } from "./context.ts";
import { redact, scrubString } from "./redact.ts";

export type { Logger } from "pino";

export interface LoggerOptions {
  /** `web` or `worker` in the product; tests use their own names. */
  readonly service: string;
  readonly level?: string;
  /** Where lines go; stdout by default. Tests pass a capturing stream. */
  readonly destination?: DestinationStream;
  /** Defaults to `process.env`; read for `LOG_LEVEL`, `NODE_ENV` and `RENDER_GIT_COMMIT`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** `RENDER_GIT_COMMIT` on Render; undefined elsewhere. */
export function releaseOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const commit = env["RENDER_GIT_COMMIT"];
  return commit ? commit : undefined;
}

export function createLogger(opts: LoggerOptions): Logger {
  const env = opts.env ?? process.env;
  const release = releaseOf(env);
  const options: pino.LoggerOptions = {
    level: opts.level ?? env["LOG_LEVEL"] ?? "info",
    base: { service: opts.service, env: env["NODE_ENV"] ?? "development", ...(release ? { release } : {}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) => redact(object) as Record<string, unknown>,
    },
    hooks: {
      // The message string is not part of the `log` object: scrub emails out of it too.
      logMethod(args, method) {
        const scrubbed = args.map((a: unknown) => (typeof a === "string" ? scrubString(a) : a));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    mixin: () => {
      const ctx = currentContext();
      return ctx ? { ...ctx } : {};
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

let processLogger: Logger | undefined;

/**
 * The process-wide logger used where no logger is passed in (the shared HTTP client). The web and
 * worker entry points set theirs at boot; until then a `service: "app"` logger is created lazily.
 */
export function getProcessLogger(): Logger {
  processLogger ??= createLogger({ service: "app" });
  return processLogger;
}

export function setProcessLogger(log: Logger): void {
  processLogger = log;
}
