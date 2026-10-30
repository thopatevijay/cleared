// Domain errors: a stable machine code plus a human message. Route handlers map them to the error envelope.

export const DOMAIN_ERROR_CODES = [
  "invalid_id",
  "invalid_instant",
  "invalid_money",
  "invalid_paypal_resource",
  "invalid_transition",
  "invariant_violated",
  "stale_update",
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> | null = null,
): DomainError {
  return { code, message, details };
}
