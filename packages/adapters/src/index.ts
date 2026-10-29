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
export * from "./paypal/dispute-schemas.ts";
