// Error reporting (M1-08), vendor-neutral: the web (`@sentry/nextjs`) and the worker (`@sentry/node`)
// each init their SDK with `sentryOptions` and register it with `setAlertSink`; product code reports
// through `reportError` / `reportWarning`, never through the SDK. Every event:
// - is tagged with the current `correlationId` (and `workspaceKind` when given), never a workspace id
//   or an email
// - goes through `scrubEvent` (`beforeSend`): cookies, auth headers, query-string tokens, user
//   identity and email addresses are removed
// Without a DSN the SDK is disabled, so nothing is sent.
import { currentContext } from "./context.ts";
import { redact, REDACTED, scrubString } from "./redact.ts";

export type AlertLevel = "error" | "warning";

/** The slice of a Sentry SDK (`@sentry/node`, `@sentry/nextjs`) used here. */
export interface AlertSink {
  captureException(error: unknown, hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> }): string;
  captureMessage(
    message: string,
    hint?: { level?: AlertLevel; tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): string;
}

export interface AlertContext {
  /** `seller` | `demo`: the kind only, never the workspace id. */
  readonly workspaceKind?: string;
  /** Extra non-personal fields; redacted like a log line. */
  readonly extra?: Record<string, unknown>;
}

let sink: AlertSink | undefined;

export function setAlertSink(next: AlertSink | undefined): void {
  sink = next;
}

function tags(ctx: AlertContext | undefined): Record<string, string> {
  const correlationId = currentContext()?.correlationId;
  return {
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(ctx?.workspaceKind === undefined ? {} : { workspaceKind: ctx.workspaceKind }),
  };
}

function extra(ctx: AlertContext | undefined): Record<string, unknown> {
  return ctx?.extra === undefined ? {} : (redact(ctx.extra) as Record<string, unknown>);
}

/** Unhandled errors and DLQ arrivals. A no-op until a sink is set (no DSN → no sink). */
export function reportError(error: unknown, ctx?: AlertContext): void {
  sink?.captureException(error, { tags: tags(ctx), extra: extra(ctx) });
}

/** Webhook quarantines, verification-failure bursts, SLO breaches (M3-09). */
export function reportWarning(message: string, ctx?: AlertContext): void {
  sink?.captureMessage(scrubString(message), { level: "warning", tags: tags(ctx), extra: extra(ctx) });
}

/**
 * Raises one warning when more than `limit` events happen within `windowMs` (then stays quiet until
 * the window has passed). M1-04 calls `record()` on each failed webhook verification: > 5 per 10 min.
 */
export function createThresholdAlert(opts: {
  readonly message: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): { record(ctx?: AlertContext): boolean } {
  const now = opts.now ?? Date.now;
  let times: number[] = [];
  let quietUntil = 0;
  return {
    record(ctx) {
      const t = now();
      times = [...times.filter((x) => x > t - opts.windowMs), t];
      if (times.length <= opts.limit || t < quietUntil) return false;
      quietUntil = t + opts.windowMs;
      reportWarning(opts.message, { ...ctx, extra: { ...ctx?.extra, count: times.length, windowMs: opts.windowMs } });
      return true;
    },
  };
}

/** Failed webhook verifications above 5 per 10 minutes (one process; M1-04 records each failure). */
export const verificationFailureAlert = createThresholdAlert({
  message: "webhook verification failures above 5 per 10 min",
  limit: 5,
  windowMs: 10 * 60_000,
});

/** A webhook event quarantined (unowned resource, M1-04): a warning, not an error. */
export function reportQuarantine(reason: string, ctx?: AlertContext): void {
  reportWarning(`webhook quarantined: ${reason}`, ctx);
}

// ---- beforeSend ----

type Json = Record<string, unknown>;

const QUERY_SECRET = /([?&](?:[^=&]*(?:token|secret|code|key|sig|signature|password)[^=&]*)=)[^&#]*/gi;

export function scrubUrl(url: string): string {
  return scrubString(url.replace(QUERY_SECRET, `$1${REDACTED}`));
}

function scrubRequest(request: Json): Json {
  const { cookies: _cookies, data: _data, ...rest } = request;
  const out = redact(rest) as Json;
  if (typeof request["url"] === "string") out["url"] = scrubUrl(request["url"]);
  if (typeof request["query_string"] === "string") out["query_string"] = scrubUrl(`?${request["query_string"]}`).slice(1);
  return out;
}

/**
 * `beforeSend` for both SDKs: removes the user (id, email, ip), cookies, request bodies, auth headers,
 * query-string tokens and every email address in messages, exception values and breadcrumbs.
 */
export function scrubEvent<E extends object>(event: E): E {
  const e = { ...(event as Json) };
  delete e["user"];
  const request = e["request"];
  if (request !== null && typeof request === "object") e["request"] = scrubRequest(request as Json);
  for (const key of ["message", "exception", "breadcrumbs", "extra", "contexts", "tags", "logentry"]) {
    if (e[key] !== undefined) e[key] = redact(e[key]);
  }
  return e as E;
}

export interface SentryEnvOptions {
  readonly service: "web" | "worker";
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides `SENTRY_DSN` (the browser reads the build-time public value). */
  readonly dsn?: string | undefined;
}

/** Shared init options: disabled without a DSN, no default PII, every event scrubbed. */
export function sentryOptions(opts: SentryEnvOptions) {
  const env = opts.env ?? process.env;
  const dsn = opts.dsn ?? env["SENTRY_DSN"] ?? "";
  const release = env["RENDER_GIT_COMMIT"];
  return {
    dsn,
    enabled: dsn !== "",
    sendDefaultPii: false,
    environment: env["NODE_ENV"] ?? "development",
    ...(release ? { release } : {}),
    initialScope: { tags: { service: opts.service } },
    beforeSend: <E extends object>(event: E): E => scrubEvent(event),
    beforeSendTransaction: <E extends object>(event: E): E => scrubEvent(event),
    tracesSampleRate: 0,
  };
}
