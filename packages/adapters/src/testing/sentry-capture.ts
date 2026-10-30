// A local Sentry ingest for tests (M1-08): a node:http server on 127.0.0.1 answers the envelope
// endpoint of a test DSN and keeps every event the SDK sends, so a test can count them and assert on
// the exact bytes that would have left the process. Nothing reaches sentry.io.
// Not msw: Sentry 11's node transport does not go through the `http.request` msw patches (a request
// to an msw-handled host fails with ENOTFOUND), so the capture server is a real socket instead. That
// also exercises the SDK's real transport end to end.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

const PROJECT_ID = "4242";

export interface CapturedEnvelope {
  /** The raw envelope text, exactly as sent (for "contains no email/cookie" assertions). */
  readonly raw: string;
  /** Parsed item payloads of type `event`. */
  readonly events: Record<string, unknown>[];
}

export interface SentryCapture {
  /** `http://publickey@127.0.0.1:<port>/4242` */
  readonly dsn: string;
  envelopes(): CapturedEnvelope[];
  events(): Record<string, unknown>[];
  close(): Promise<void>;
}

function parseEnvelope(raw: string): CapturedEnvelope {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const events: Record<string, unknown>[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const header = JSON.parse(lines[i] ?? "{}") as { type?: string };
    if (header.type === "event") events.push(JSON.parse(lines[i + 1] ?? "{}") as Record<string, unknown>);
  }
  return { raw, events };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  return (req.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8");
}

export async function startSentryCapture(): Promise<SentryCapture> {
  const envelopes: CapturedEnvelope[] = [];
  const server = createServer((req, res) => {
    void body(req).then((text) => {
      if (req.method === "POST" && req.url?.startsWith(`/api/${PROJECT_ID}/envelope/`)) {
        envelopes.push(parseEnvelope(text));
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"id":"captured"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    dsn: `http://publickey@127.0.0.1:${String(port)}/${PROJECT_ID}`,
    envelopes: () => [...envelopes],
    events: () => envelopes.flatMap((e) => e.events),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
