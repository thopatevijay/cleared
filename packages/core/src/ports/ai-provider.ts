// AiProvider port (ADR 0009/0010): the harness's only way to reach a model. No SDK here; the OpenAI
// adapter (`packages/adapters/src/ai/openai-provider.ts`) implements it. Evidence travels only in
// `dataBlocks`; `system` and `task` carry our own text and never evidence (input guardrail).
import type { z } from "zod";
import type { Sha256 } from "../ids.ts";

interface DataBlockBase {
  /** stable id the model cites, e.g. `E1` */
  readonly id: string;
  /** sha256 of the item's content (text: UTF-8; binary: the decoded bytes) */
  readonly sha256: Sha256;
  readonly label: string;
  /** the injection scan matched; the text is wrapped again in an `<untrusted>` marker */
  readonly flagged: boolean;
}

export type DataBlock =
  | (DataBlockBase & { readonly kind: "text"; readonly text: string })
  | (DataBlockBase & {
      readonly kind: "image";
      readonly mimeType: "image/png" | "image/jpeg" | "image/gif";
      readonly base64: string;
    })
  | (DataBlockBase & { readonly kind: "pdf"; readonly filename: string; readonly base64: string });

export interface CompletionRequest<S extends z.ZodType> {
  readonly model: string;
  /** our instructions only (the system channel) */
  readonly system: string;
  /** our own per-call task text (e.g. a claim list, a repair note), placed before the data blocks */
  readonly task: string;
  readonly dataBlocks: readonly DataBlock[];
  readonly schemaName: string;
  readonly schema: S;
  readonly maxOutputTokens: number;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/**
 * - `timeout` / `unavailable`: the provider did not answer usefully (timeout, network, 5xx, 429, breaker
 *   open). The harness degrades: callers show facts without a verdict.
 * - `rejected`: a 4xx other than 429 (our request is wrong). Not a degradation; never trips the breaker.
 * - `refusal` / `incomplete` / `invalid_output`: the model answered, but not with usable output.
 */
export const AI_FAILURE_KINDS = [
  "timeout",
  "unavailable",
  "rejected",
  "refusal",
  "incomplete",
  "invalid_output",
] as const;
export type AiFailureKind = (typeof AI_FAILURE_KINDS)[number];

export const DEGRADING_FAILURES: ReadonlySet<AiFailureKind> = new Set(["timeout", "unavailable"]);

interface CompletionMeta {
  readonly model: string;
  /** null when the provider sent no usage (transport failure) */
  readonly usage: AiUsage | null;
  /** billed cost; failures can cost money too (an `incomplete` answer is billed) */
  readonly costUsd: number;
  readonly latencyMs: number;
}

export type CompletionResult<T> =
  | ({ readonly ok: true; readonly output: T } & CompletionMeta)
  | ({
      readonly ok: false;
      readonly error: { readonly kind: AiFailureKind; readonly detail: string };
    } & CompletionMeta);

export interface AiProvider {
  complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>>;
}
