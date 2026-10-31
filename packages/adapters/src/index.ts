// Vendor adapters (PayPal, OpenAI, BlobStore, PDF, email) behind interfaces from @cleared/core.
import { CORE_PACKAGE } from "@cleared/core";

export const ADAPTERS_PACKAGE = "@cleared/adapters";
export const dependsOn: readonly string[] = [CORE_PACKAGE];

export * from "./http/client.ts";
export * from "./http/errors.ts";
export { createBreaker, type Breaker, type BreakerState } from "./http/breaker.ts";
export * from "./paypal/token.ts";
export * from "./paypal/orders.ts";
export * from "./paypal/schemas.ts";
export * from "./paypal/disputes.ts";
export * from "./paypal/disputes.schemas.ts";
export * from "./paypal/webhooks.ts";
export * from "./paypal/webhook-verify.ts";
export * from "./paypal/webhook-ingest.ts";
export * from "./paypal/captures.ts";
export * from "./paypal/test-payment.ts";
export * from "./obs/context.ts";
export * from "./obs/log.ts";
export * from "./email/sender.ts";
export * from "./email/resend.ts";
export * from "./email/templates/render.ts";
export * from "./obs/redact.ts";
export * from "./obs/http-logging.ts";
export * from "./obs/sentry.ts";
export { createOpenAiCompletionProvider, failureKind, toEvidencePart } from "./ai/openai-provider.ts";
export * from "./ai/pricing.ts";
export { ExtractResult, ScopeClaims, ScopeVerdicts } from "./ai/schemas.ts";
