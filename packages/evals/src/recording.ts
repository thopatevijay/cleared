// Recorded model calls for the eval runner (M4-02). One recording per model call, keyed by the workflow run's
// `input_hash` (the harness's content-hash cache key) and the call's index in that run:
// `fixtures/openai/eval/<task>/<input_hash>.<n>.json`.
// - replay: the real OpenAI adapter sends its request to a `fetch` that serves the recording. A missing
//   recording, or one whose recorded request differs from the request the code builds now, fails with
//   "recording stale". That is how a prompt, model or schema change is forced through the live eval.
// - live: the real adapter calls OpenAI through the shared HTTP client; the final exchange is scrubbed and
//   written, then the answer is read back FROM the recording (BL-01 6601047277: the scrubber rewrites some
//   digits and emails inside model answers, so both modes must build their output from the same bytes).
// Spend is taken from each live response's usage (tokens × pricing.ts) at call time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOpenAiCompletionProvider } from "@cleared/adapters/ai/openai-provider";
import { OPENAI_TIMEOUT_MS } from "@cleared/adapters/ai/openai";
import { createHttpClient, type Exchange } from "@cleared/adapters/http/client";
import { FIXTURES_DIR, FixtureSchema, responseText, type Fixture } from "@cleared/adapters/testing/fixture";
import { toFixture } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import type { AiProvider, CompletionRequest, CompletionResult } from "@cleared/core";
import type { z } from "zod";

export const EVAL_FIXTURE_DIR = join(FIXTURES_DIR, "openai", "eval");
export const STALE_MESSAGE = "recording stale: prompt/model/schema changed; run the live eval";
const TICKET = "M4-02";

export class StaleRecordingError extends Error {
  readonly recording: string;
  constructor(recording: string, why: string) {
    super(`${STALE_MESSAGE} (${recording}: ${why})`);
    this.name = "StaleRecordingError";
    this.recording = recording;
  }
}

export type EvalMode = "replay" | "live";

export interface CallSpend {
  readonly recording: string;
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface RecorderOptions {
  readonly mode: EvalMode;
  /** live only; never logged or written (the scrubber also redacts it) */
  readonly apiKey?: string;
  readonly dir?: string;
  /** live only: called once per billed call, from the API response's usage */
  readonly onSpend?: (s: CallSpend) => void;
}

export interface Recorder {
  /** An AiProvider bound to one workflow run (its task and input hash); calls are numbered 1, 2, … */
  forRun(task: string, inputHash: string): AiProvider;
  /** every stale recording met so far (replay) */
  readonly stale: StaleRecordingError[];
}

/** The live call's latency travels in the recording's note, so a replayed report shows the live latency. */
interface Note {
  readonly latency_ms: number;
}

function readNote(f: Fixture): Note | null {
  if (f.meta.note === undefined) return null;
  try {
    const n = JSON.parse(f.meta.note) as Partial<Note>;
    return typeof n.latency_ms === "number" ? { latency_ms: n.latency_ms } : null;
  } catch {
    return null;
  }
}

const scrubbedBody = (body: string): unknown => createScrubber().value(JSON.parse(body));

/** A fetch that answers with the recording, after checking the request is the recorded one. */
function recordingFetch(name: string, file: string, stale: StaleRecordingError[]): typeof fetch {
  const refuse = (why: string): Promise<never> => {
    const e = new StaleRecordingError(name, why);
    stale.push(e);
    return Promise.reject(e);
  };
  return (_input, init) => {
    if (!existsSync(file)) return refuse("no recording");
    const fixture = FixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const body = typeof init?.body === "string" ? init.body : "";
    if (JSON.stringify(scrubbedBody(body)) !== JSON.stringify(fixture.request.body))
      return refuse("the request differs from the recording");
    return Promise.resolve(
      new Response(responseText(fixture), { status: fixture.response.status, headers: fixture.response.headers }),
    );
  };
}

function replayProvider(name: string, file: string, stale: StaleRecordingError[]): AiProvider {
  const http = createHttpClient({
    vendor: "openai",
    timeoutMs: OPENAI_TIMEOUT_MS,
    log: false,
    maxRetries: 0,
    fetch: recordingFetch(name, file, stale),
  });
  const inner = createOpenAiCompletionProvider({ apiKey: "replay", http });
  return {
    worstCaseUsd: (req) => inner.worstCaseUsd?.(req) ?? 0,
    async complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
      const res = await inner.complete(req);
      const note = existsSync(file) ? readNote(FixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")))) : null;
      return note ? { ...res, latencyMs: note.latency_ms } : res;
    },
  };
}

function writeRecording(file: string, ex: Exchange, apiKey: string, latencyMs: number): void {
  const note = JSON.stringify({ latency_ms: latencyMs } satisfies Note);
  const fixture = toFixture(ex, createScrubber({ secrets: () => [apiKey] }), TICKET, new Date(), note, "live");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}

/** Read through a function: the hook sets it while `complete` is awaited (no narrowing across that). */
const lastOf = (seen: { last: Exchange | null }): Exchange | null => seen.last;

function liveProvider(name: string, file: string, opts: RecorderOptions, stale: StaleRecordingError[]): AiProvider {
  const apiKey = opts.apiKey ?? "";
  if (apiKey === "") throw new Error("live eval: OPENAI_API_KEY is not set");
  const seen: { last: Exchange | null } = { last: null };
  const http = createHttpClient({
    vendor: "openai",
    timeoutMs: OPENAI_TIMEOUT_MS,
    log: false,
    onExchange: (e) => {
      seen.last = e;
    },
  });
  const live = createOpenAiCompletionProvider({ apiKey, http });
  return {
    worstCaseUsd: (req) => live.worstCaseUsd?.(req) ?? 0,
    async complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
      seen.last = null;
      const res = await live.complete(req);
      opts.onSpend?.({ recording: name, model: res.model, costUsd: res.costUsd, latencyMs: res.latencyMs });
      const exchange = lastOf(seen);
      if (exchange === null) return res; // no HTTP answer (timeout, network): nothing to record
      writeRecording(file, exchange, apiKey, res.latencyMs);
      const answer = await replayProvider(name, file, stale).complete(req);
      // the billed cost is the live one (identical usage; kept explicit)
      return { ...answer, costUsd: res.costUsd, latencyMs: res.latencyMs };
    },
  };
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const dir = opts.dir ?? EVAL_FIXTURE_DIR;
  const stale: StaleRecordingError[] = [];
  /** live: the recordings made (or being made) in this run, by name */
  const recorded = new Map<string, Promise<void>>();
  return {
    stale,
    forRun(task, inputHash) {
      let n = 0;
      const next = (): { name: string; file: string } => {
        n += 1;
        const name = `${task}/${inputHash}.${String(n)}`;
        return { name, file: join(dir, `${name}.json`) };
      };
      const probe = replayProvider("probe", join(dir, "__none__.json"), []);
      return {
        worstCaseUsd: (req) => probe.worstCaseUsd?.(req) ?? 0,
        async complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
          const { name, file } = next();
          if (opts.mode === "replay") return replayProvider(name, file, stale).complete(req);
          // Like the content-hash cache: the same input is answered once per live run, then from its
          // recording (two items with the same hold rule and locale, a clean twin's unchanged documents).
          const pending = recorded.get(name);
          if (pending) {
            await pending;
            return replayProvider(name, file, stale).complete(req);
          }
          const call = liveProvider(name, file, opts, stale).complete(req);
          recorded.set(name, call.then(() => undefined, () => undefined));
          return call;
        },
      };
    },
  };
}
