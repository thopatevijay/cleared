// The job envelope every queue carries (M1-03). `messageId` is the idempotency key consumers record in
// `consumer_receipts`; for an emitted event it is the outbox row id. `correlationId` is restored into
// the worker's log context before the handler runs. Validated on both sides (trust boundary).
import { z } from "zod";

export const EnvelopeSchema = z.object({
  messageId: z.uuid(),
  correlationId: z.string().min(1).max(200),
  workspaceId: z.uuid().optional(),
  data: z.unknown(),
});

export type Envelope<T = unknown> = Omit<z.infer<typeof EnvelopeSchema>, "data"> & { data: T };

/** Parses a job payload; throws a ZodError for anything that is not an envelope. */
export function parseEnvelope(value: unknown): Envelope {
  return EnvelopeSchema.parse(value);
}

/** Supplies the correlation id when a message is created (the worker wires the log context's). */
export type CorrelationSource = () => string;
