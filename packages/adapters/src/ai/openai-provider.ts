// The core `AiProvider` port (packages/core/src/ports/ai-provider.ts) on M0-07's OpenAI adapter
// (openai.ts): data blocks become `<evidence id sha256 …>` parts, `system` goes to `instructions`, and
// adapter errors map to the port's failure kinds. Transport stays the shared HTTP client (60 s timeout,
// retries only on 429 for this non-idempotent POST, the breaker counts timeouts/network/5xx/429 only).
import type {
  AiFailureKind,
  AiProvider,
  CompletionRequest,
  CompletionResult,
  DataBlock,
} from "@cleared/core";
import type { z } from "zod";
import {
  createOpenAiProvider,
  type AiResult,
  type EvidencePart,
  type OpenAiProviderOptions,
} from "./openai.ts";

export function toEvidencePart(b: DataBlock): EvidencePart {
  const tags = { evidenceId: b.id, label: b.label, sha256: b.sha256, flagged: b.flagged };
  if (b.kind === "text") return { ...tags, kind: "text", text: b.text };
  if (b.kind === "image") return { ...tags, kind: "image", mimeType: b.mimeType, base64: b.base64 };
  return { ...tags, kind: "pdf", filename: b.filename, base64: b.base64 };
}

/**
 * timeout → `timeout`; network, open breaker, 429, 5xx → `unavailable` (the run degrades); any other
 * 4xx → `rejected` (our bug: not a degradation, and the shared client never counts it on the breaker).
 */
export function failureKind(error: { kind: string; status: number | null }): AiFailureKind {
  switch (error.kind) {
    case "timeout":
      return "timeout";
    case "connection":
      return "unavailable";
    case "refusal":
      return "refusal";
    case "incomplete":
      return "incomplete";
    case "schema_violation":
      return "invalid_output";
    default: {
      const s = error.status;
      return s === null || s === 429 || s >= 500 ? "unavailable" : "rejected";
    }
  }
}

function toCompletion<T>(res: AiResult<T>): CompletionResult<T> {
  const meta = { model: res.model, usage: res.usage, costUsd: res.costUsd, latencyMs: res.latencyMs };
  if (res.ok) return { ok: true, output: res.value, ...meta };
  return { ok: false, error: { kind: failureKind(res.error), detail: res.error.detail }, ...meta };
}

export function createOpenAiCompletionProvider(opts: OpenAiProviderOptions): AiProvider {
  const openai = createOpenAiProvider(opts);
  return {
    async complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
      const res = await openai.generate({
        model: req.model,
        schemaName: req.schemaName,
        schema: req.schema,
        instructions: req.system,
        task: req.task,
        evidence: req.dataBlocks.map(toEvidencePart),
        maxOutputTokens: req.maxOutputTokens,
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      });
      return toCompletion<z.infer<S>>(res);
    },
  };
}
