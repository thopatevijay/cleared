// Fixture recorder: plug `recorder.onExchange` into `createHttpClient({ onExchange })`, set a label
// before each logical step, and every exchange is scrubbed and written as
// `<dir>/<label>.json` (further exchanges under the same label get `.2`, `.3`…).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exchange } from "../http/client.ts";
import type { Fixture } from "./fixture.ts";

type FixtureEnv = Fixture["meta"]["env"];
import { REQUEST_HEADER_ALLOW, RESPONSE_HEADER_ALLOW, type Scrubber } from "./scrub.ts";

export interface RecorderOptions {
  /** Root directory, e.g. `<repo>/fixtures/paypal`. */
  readonly dir: string;
  readonly ticket: string;
  readonly scrubber: Scrubber;
  /** `fixture.meta.env`: "sandbox" (default) or "live" for a vendor without a sandbox (OpenAI). */
  readonly env?: FixtureEnv;
  /** Rewrites an exchange before scrubbing (e.g. eliding inline base64 file payloads). */
  readonly transform?: (exchange: Exchange) => Exchange;
  readonly now?: () => Date;
}

export interface Recorder {
  readonly onExchange: (exchange: Exchange) => void;
  /** Names the next exchange(s), e.g. `orders/create-goods-a`. */
  label(name: string, note?: string): void;
  /** Files written so far (relative to `dir`, without `.json`). */
  readonly written: readonly string[];
}

export function createRecorder(options: RecorderOptions): Recorder {
  const now = options.now ?? (() => new Date());
  const written: string[] = [];
  let current: { name: string; note: string | undefined; count: number } | undefined;

  function onExchange(exchange: Exchange): void {
    if (current === undefined) throw new Error("recorder: label() before the first exchange");
    current.count += 1;
    const name = current.count === 1 ? current.name : `${current.name}.${String(current.count)}`;
    const ex = options.transform ? options.transform(exchange) : exchange;
    const fixture = toFixture(ex, options.scrubber, options.ticket, now(), current.note, options.env);
    const file = join(options.dir, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    written.push(name);
  }

  return {
    onExchange,
    label(name, note) {
      current = { name, note, count: 0 };
    },
    written,
  };
}

export function toFixture(
  e: Exchange,
  s: Scrubber,
  ticket: string,
  at: Date,
  note?: string,
  env: FixtureEnv = "sandbox",
): Fixture {
  return {
    meta: {
      recorded_at: at.toISOString(),
      env,
      ticket,
      scrubbed: true,
      ...(note === undefined ? {} : { note }),
    },
    request: {
      method: e.request.method,
      url: s.text(e.request.url),
      headers: s.headers(e.request.headers, REQUEST_HEADER_ALLOW),
      body: e.request.body === undefined ? null : scrubBody(e.request.body, s),
    },
    response: {
      status: e.response.status,
      headers: s.headers(e.response.headers, RESPONSE_HEADER_ALLOW),
      body: scrubBody(e.response.body, s),
    },
  };
}

function scrubBody(body: string, s: Scrubber): unknown {
  if (body === "") return null;
  try {
    return s.value(JSON.parse(body));
  } catch {
    return s.text(body);
  }
}
