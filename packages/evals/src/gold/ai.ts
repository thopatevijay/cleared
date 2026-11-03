// Recorded model calls for the gold tooling. Live: each call gets its own shared HTTP client (ADR 0011)
// whose final exchange is scrubbed and written to `fixtures/openai/gold/<name>.json`; the answer is then
// read back FROM that fixture. Replay: the same request goes to a `fetch` that serves the fixture. Both
// modes therefore build their output from the same recorded bytes (`--replay` is byte-identical), and
// replay refuses a fixture whose recorded request differs from the one the code builds now.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOpenAiProvider, OPENAI_TIMEOUT_MS, type EvidencePart } from "@cleared/adapters/ai/openai";
import type { TokenUsage } from "@cleared/adapters/ai/pricing";
import { createHttpClient, type Exchange } from "@cleared/adapters/http/client";
import { FIXTURES_DIR, FixtureSchema, responseText, type Fixture } from "@cleared/adapters/testing/fixture";
import { toFixture } from "@cleared/adapters/testing/record";
import { createScrubber } from "@cleared/adapters/testing/scrub";
import type { z } from "zod";

export const GOLD_FIXTURE_DIR = join(FIXTURES_DIR, "openai", "gold");
const TICKET = "M4-01";

export interface CallSpec<S extends z.ZodType> {
  /** fixture name under fixtures/openai/gold, e.g. `draft/ext-001` */
  readonly name: string;
  readonly model: string;
  readonly schemaName: string;
  readonly schema: S;
  readonly instructions: string;
  readonly task: string;
  readonly evidence: readonly EvidencePart[];
  readonly maxOutputTokens: number;
  readonly reasoningEffort: "none" | "low";
}

export interface CallResult<T> {
  readonly value: T;
  readonly model: string;
  readonly usage: TokenUsage | null;
  readonly costUsd: number;
}

export interface Caller {
  call<S extends z.ZodType>(spec: CallSpec<S>): Promise<CallResult<z.infer<S>>>;
}

const fixturePath = (name: string): string => join(GOLD_FIXTURE_DIR, `${name}.json`);

export function loadGoldFixture(name: string): Fixture {
  return FixtureSchema.parse(JSON.parse(readFileSync(fixturePath(name), "utf8")));
}

/** A `fetch` that answers with the recorded response and checks the request matches the recording. */
function fixtureFetch(name: string): typeof fetch {
  const fixture = loadGoldFixture(name);
  return (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const now = JSON.stringify(createScrubber().value(JSON.parse(body)));
    if (now !== JSON.stringify(fixture.request.body)) {
      return Promise.reject(new Error(`replay: request for ${name} differs from the recording (re-record it)`));
    }
    const res = new Response(responseText(fixture), { status: fixture.response.status, headers: fixture.response.headers });
    return Promise.resolve(res);
  };
}

async function generateVia<S extends z.ZodType>(
  spec: CallSpec<S>,
  opts: { apiKey: string; fetch?: typeof fetch; onExchange?: (e: Exchange) => void },
): Promise<CallResult<z.infer<S>>> {
  const http = createHttpClient({
    vendor: "openai",
    timeoutMs: OPENAI_TIMEOUT_MS,
    log: false,
    ...(opts.fetch ? { fetch: opts.fetch, maxRetries: 0 } : {}),
    ...(opts.onExchange ? { onExchange: opts.onExchange } : {}),
  });
  const res = await createOpenAiProvider({ apiKey: opts.apiKey, http }).generate({
    model: spec.model,
    schemaName: spec.schemaName,
    schema: spec.schema,
    instructions: spec.instructions,
    task: spec.task,
    evidence: spec.evidence,
    maxOutputTokens: spec.maxOutputTokens,
    reasoningEffort: spec.reasoningEffort,
  });
  if (!res.ok) throw new Error(`${spec.name}: ${res.error.kind}: ${res.error.detail}`);
  return { value: res.value, model: res.model, usage: res.usage, costUsd: res.costUsd };
}

export function createReplayCaller(): Caller {
  return {
    call: (spec) => generateVia(spec, { apiKey: "replay", fetch: fixtureFetch(spec.name) }),
  };
}

export interface LiveOptions {
  readonly apiKey: string;
  /** refuse the next call once this run has spent this much (USD) */
  readonly maxUsd: number;
  readonly onSpend: (r: CallResult<unknown>, name: string) => void;
}

/** Live: record the final exchange, then answer from the recording (same bytes as replay). */
export function createLiveCaller(opts: LiveOptions): Caller & { spentUsd(): number } {
  let spent = 0;
  const replay = createReplayCaller();
  return {
    spentUsd: () => spent,
    async call(spec) {
      if (spent >= opts.maxUsd) throw new Error(`budget: run cap $${opts.maxUsd.toFixed(2)} reached`);
      let last: Exchange | undefined;
      const live = await generateVia(spec, { apiKey: opts.apiKey, onExchange: (e) => (last = e) });
      spent += live.costUsd;
      opts.onSpend(live, spec.name);
      if (last === undefined) throw new Error(`${spec.name}: no exchange recorded`);
      writeFixture(spec.name, last, opts.apiKey);
      return replay.call(spec);
    },
  };
}

function writeFixture(name: string, ex: Exchange, apiKey: string): void {
  const fixture = toFixture(ex, createScrubber({ secrets: () => [apiKey] }), TICKET, new Date(), undefined, "live");
  const file = fixturePath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}
