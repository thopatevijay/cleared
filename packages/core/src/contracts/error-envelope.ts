// The one API error envelope (ADR 0003): { error: { code, message, details, correlationId } }.
import { z } from "zod";
import type { DomainError } from "../errors.ts";

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        /** snake_case machine code, stable across releases */
        code: z.string().regex(/^[a-z][a-z0-9_]*$/),
        /** plain-text message safe to show the user */
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).nullable(),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function errorEnvelope(input: {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, unknown>> | null;
}): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({
    error: {
      code: input.code,
      message: input.message,
      details: input.details ?? null,
      correlationId: input.correlationId,
    },
  });
}

export function domainErrorEnvelope(error: DomainError, correlationId: string): ErrorEnvelope {
  return errorEnvelope({ code: error.code, message: error.message, details: error.details, correlationId });
}
