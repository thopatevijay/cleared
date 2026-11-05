// AiProvider on the openai SDK (ADR 0009): Responses API, strict structured output from a zod
// schema (z.toJSONSchema), the output re-validated with zod, usage -> cost from pricing.ts.
// Evidence travels in a delimited data channel in the user message; `instructions` carries only
// our own text (project rule: evidence is data, never instructions).
// Transport: the SDK's fetch is routed through the shared HTTP client (ADR 0011: OpenAI 60 s
// timeout, retries only on timeout/5xx/429 with jitter and Retry-After, the breaker, onExchange
// for the fixture recorder). The SDK's own retries are off so the shared client is the only policy.
import OpenAI from "openai";
import type { Response as OaiResponse, ResponseInputContent } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  createHttpClient,
  VENDOR_TIMEOUTS_MS,
  type Exchange,
  type HttpClient,
  type HttpMethod,
} from "../http/client.ts";
import { CircuitOpenError, HttpStatusError, HttpTimeoutError } from "../http/errors.ts";
import { costUsd, type TokenUsage } from "./pricing.ts";
import { ResponseUsage } from "./schemas.ts";

/** M2-02: the item's sha256 and injection flag, rendered as attributes of the evidence tag. */
interface PartTags {
  readonly sha256?: string;
  readonly flagged?: boolean;
}

export type EvidencePart = PartTags &
  (
    | { readonly kind: "text"; readonly evidenceId: string; readonly label: string; readonly text: string }
    | {
        readonly kind: "image";
        readonly evidenceId: string;
        readonly label: string;
        readonly mimeType: "image/png" | "image/jpeg" | "image/gif";
        readonly base64: string;
      }
    | {
        readonly kind: "pdf";
        readonly evidenceId: string;
        readonly label: string;
        readonly filename: string;
        readonly base64: string;
      }
  );

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface StructuredRequest<S extends z.ZodType> {
  readonly model: string;
  readonly schemaName: string;
  readonly schema: S;
  readonly instructions: string;
  /** Our own task text for this call (e.g. a claim list from pass 1); placed before the evidence. */
  readonly task: string;
  readonly evidence: readonly EvidencePart[];
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
}

export type AiErrorKind = "refusal" | "incomplete" | "schema_violation" | "http" | "timeout" | "connection";

export interface AiMeta {
  readonly model: string;
  readonly usage: TokenUsage | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly responseId: string | null;
}

export type AiResult<T> =
  | ({ readonly ok: true; readonly value: T } & AiMeta)
  | ({
      readonly ok: false;
      /** `status`: the HTTP status for `http` errors (M2-02 tells a 4xx from a 5xx/429), else null */
      readonly error: { readonly kind: AiErrorKind; readonly detail: string; readonly status: number | null };
    } & AiMeta);

export interface AiProvider {
  generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<AiResult<z.infer<S>>>;
}

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  /** The shared client to send through; built with the OpenAI defaults when absent. */
  readonly http?: HttpClient;
  /** Used only when `http` is absent: per-call timeout (default 60 s) and the recorder hook. */
  readonly timeoutMs?: number;
  readonly onExchange?: (exchange: Exchange) => void;
}

export const OPENAI_TIMEOUT_MS = VENDOR_TIMEOUTS_MS.openai;

export function createOpenAiProvider(opts: OpenAiProviderOptions): AiProvider {
  const http =
    opts.http ??
    createHttpClient({
      vendor: "openai",
      timeoutMs: opts.timeoutMs ?? OPENAI_TIMEOUT_MS,
      ...(opts.onExchange ? { onExchange: opts.onExchange } : {}),
    });
  // The SDK timeout is only a backstop above the shared client's; the shared client times out first.
  const client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 0, timeout: 120_000, fetch: fetchVia(http) });
  return {
    async generate(req) {
      const started = performance.now();
      try {
        const res = await client.responses.create(buildRequest(req));
        return interpret(req, res, performance.now() - started);
      } catch (err) {
        const ms = performance.now() - started;
        return failure(req.model, transportKind(err), errorDetail(err), ms, null, null, httpStatus(err));
      }
    },
  };
}

/** A `fetch` for the SDK that sends through the shared client and hands non-2xx back as a Response. */
export function fetchVia(http: HttpClient): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : undefined;
    const method = (init?.method ?? "GET").toUpperCase() as HttpMethod;
    try {
      const res = await http.request({ method, url, headers, ...(body === undefined ? {} : { body }) });
      return new Response(res.bodyText, { status: res.status, headers: res.headers });
    } catch (err) {
      if (err instanceof HttpStatusError) {
        return new Response(err.bodyText, { status: err.status, headers: err.headers });
      }
      throw err;
    }
  };
}

/** zod -> JSON Schema for strict mode: drops `$schema`; refuses optional properties (strict needs all required). */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  assertAllRequired(json, "$");
  return json;
}

function assertAllRequired(node: unknown, path: string): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "object" && obj.properties !== undefined) {
    const keys = Object.keys(obj.properties as object);
    const required = new Set((obj.required as string[] | undefined) ?? []);
    const missing = keys.filter((k) => !required.has(k));
    if (missing.length > 0)
      throw new Error(`strict schema: optional properties at ${path}: ${missing.join(", ")}`);
  }
  for (const [k, v] of Object.entries(obj)) assertAllRequired(v, `${path}.${k}`);
}

/** Escapes our delimiter inside evidence text so an item cannot close its own block. */
function fence(text: string): string {
  return text.replaceAll("</evidence", "<\\/evidence");
}

export function evidenceContent(parts: readonly EvidencePart[]): ResponseInputContent[] {
  const out: ResponseInputContent[] = [];
  for (const p of parts) {
    const tags = `${p.sha256 ? ` sha256="${p.sha256}"` : ""}${p.flagged ? ' flagged="true"' : ""}`;
    const open = `<evidence id="${p.evidenceId}"${tags} kind="${p.kind}" label="${fence(p.label).replaceAll('"', "'")}">`;
    if (p.kind === "text") {
      out.push({ type: "input_text", text: `${open}\n${fence(p.text)}\n</evidence>` });
    } else if (p.kind === "image") {
      out.push({ type: "input_text", text: open });
      out.push({ type: "input_image", detail: "auto", image_url: `data:${p.mimeType};base64,${p.base64}` });
      out.push({ type: "input_text", text: "</evidence>" });
    } else {
      out.push({ type: "input_text", text: open });
      out.push({
        type: "input_file",
        filename: p.filename,
        file_data: `data:application/pdf;base64,${p.base64}`,
      });
      out.push({ type: "input_text", text: "</evidence>" });
    }
  }
  return out;
}

function buildRequest<S extends z.ZodType>(
  req: StructuredRequest<S>,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  return {
    model: req.model,
    instructions: req.instructions,
    input: [
      { role: "user", content: [{ type: "input_text", text: req.task }, ...evidenceContent(req.evidence)] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: req.schemaName,
        schema: toStrictJsonSchema(req.schema),
        strict: true,
      },
    },
    max_output_tokens: req.maxOutputTokens,
    store: false,
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
  };
}

function readUsage(res: OaiResponse): TokenUsage | null {
  const parsed = ResponseUsage.safeParse(res.usage);
  if (!parsed.success) return null;
  const u = parsed.data;
  return {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.input_tokens_details.cached_tokens,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details.reasoning_tokens,
  };
}

function refusalOf(res: OaiResponse): string | null {
  for (const item of res.output) {
    if (item.type !== "message") continue;
    for (const c of item.content) if (c.type === "refusal") return c.refusal;
  }
  return null;
}

function interpret<S extends z.ZodType>(
  req: StructuredRequest<S>,
  res: OaiResponse,
  latencyMs: number,
): AiResult<z.infer<S>> {
  const usage = readUsage(res);
  const fail = (kind: AiErrorKind, detail: string): AiResult<z.infer<S>> =>
    failure(req.model, kind, detail, latencyMs, usage, res.id);
  const refusal = refusalOf(res);
  if (refusal !== null) return fail("refusal", refusal);
  if (res.status === "incomplete") return fail("incomplete", res.incomplete_details?.reason ?? "unknown");
  let json: unknown;
  try {
    json = JSON.parse(res.output_text);
  } catch {
    return fail("schema_violation", "output is not JSON");
  }
  const parsed = req.schema.safeParse(json);
  if (!parsed.success) return fail("schema_violation", z.prettifyError(parsed.error));
  return { ok: true, value: parsed.data, ...meta(req.model, usage, latencyMs, res.id) };
}

function meta(model: string, usage: TokenUsage | null, latencyMs: number, responseId: string | null): AiMeta {
  return {
    model,
    usage,
    costUsd: usage ? costUsd(model, usage) : 0,
    latencyMs: Math.round(latencyMs),
    responseId,
  };
}

function failure<T>(
  model: string,
  kind: AiErrorKind,
  detail: string,
  latencyMs: number,
  usage: TokenUsage | null,
  responseId: string | null,
  status: number | null = null,
): AiResult<T> {
  return { ok: false, error: { kind, detail, status }, ...meta(model, usage, latencyMs, responseId) };
}

function httpStatus(err: unknown): number | null {
  return err instanceof OpenAI.APIError && typeof err.status === "number" ? err.status : null;
}

function transportKind(err: unknown): AiErrorKind {
  const cause = err instanceof Error ? err.cause : undefined;
  if (err instanceof HttpTimeoutError || cause instanceof HttpTimeoutError) return "timeout";
  if (err instanceof CircuitOpenError || cause instanceof CircuitOpenError) return "connection";
  if (err instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (err instanceof OpenAI.APIConnectionError) return "connection";
  return "http";
}

function errorDetail(err: unknown): string {
  if (err instanceof OpenAI.APIError)
    return `${String(err.status ?? 0)} ${err.code ?? err.type ?? ""} ${err.message}`.trim();
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}
