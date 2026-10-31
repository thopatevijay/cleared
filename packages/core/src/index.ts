// Domain core: entities, invariants and state machines. No framework, SDK or I/O imports (ADR 0001).
export const CORE_PACKAGE = "@cleared/core";

export * from "./result.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./time.ts";
export * from "./money.ts";
export * from "./machine.ts";
export * from "./mirror.ts";
export * from "./events.ts";
export * from "./contracts/error-envelope.ts";
export * from "./contracts/payments.ts";

export * from "./accounts/workspace.ts";
export * from "./accounts/ownership.ts";
export * from "./payments/capture.ts";
export * from "./payments/payment.ts";
export * from "./proof/pack.ts";
export * from "./proof/evidence.ts";
export * from "./holds/hold.ts";
export * from "./disputes/dispute.ts";
export * from "./disputes/mirror.ts";
export * from "./disputes/deadline.ts";
export * from "./actions/action.ts";
export * from "./actions/canonical-json.ts";
export * from "./actions/policy.ts";
export * from "./agent/index.ts";
