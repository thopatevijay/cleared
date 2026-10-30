// Sentry for the web server (M1-08): disabled when SENTRY_DSN is empty; no default PII; every event
// scrubbed by the shared `beforeSend`. Product code reports through `reportError`/`reportWarning`.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions, setAlertSink } from "@cleared/adapters";
import { webLogger } from "./src/server/request-context.ts";

const options = sentryOptions({ service: "web" });
Sentry.init(options);
if (options.enabled) setAlertSink(Sentry);
webLogger().info({ sentry: options.enabled }, "web observability ready");
