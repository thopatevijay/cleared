// M0-06 throwaway webhook receiver (NOT the product route; that is M1-04). Writes each delivery's raw
// body bytes, untouched, plus every `paypal-*` header and the receive time, to $TMPDIR/m0-06/, then
// answers 200. Exposed on HTTPS 443 by a cloudflared quick tunnel.
//
//   pnpm tsx scripts/spikes/webhook-receiver.ts            # port 8080 + PORT_OFFSET (default 0)
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RECEIVER_DIR = join(process.env.TMPDIR ?? tmpdir(), "m0-06");
const MAX_BYTES = 1_000_000;

export interface DeliveryMeta {
  readonly received_at: string;
  readonly received_ms: number;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly bytes: number;
}

function main(): void {
  const port = 8080 + Number(process.env.PORT_OFFSET ?? "0");
  mkdirSync(RECEIVER_DIR, { recursive: true });
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      const receivedMs = Date.now();
      if (req.method !== "POST" || size > MAX_BYTES) {
        res.writeHead(req.method === "POST" ? 413 : 404).end();
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter(([k]) => k.startsWith("paypal-") || k === "content-type" || k === "user-agent")
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
      );
      const base = join(RECEIVER_DIR, `${String(receivedMs)}-${String(++n).padStart(3, "0")}`);
      const meta: DeliveryMeta = {
        received_at: new Date(receivedMs).toISOString(),
        received_ms: receivedMs,
        path: req.url ?? "/",
        headers,
        bytes: size,
      };
      writeFileSync(`${base}.body`, Buffer.concat(chunks));
      writeFileSync(`${base}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
      console.log(
        JSON.stringify({ at: meta.received_at, bytes: size, id: headers["paypal-transmission-id"] }),
      );
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ listening: port, dir: RECEIVER_DIR }));
  });
}

if (process.argv[1]?.endsWith("webhook-receiver.ts")) main();
