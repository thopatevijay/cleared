// BL-01 6489047945 regression: a request aborted by the client timeout does not stall later requests on
// the same shared HTTP client (real sockets: a local server, the default undici dispatcher). The M0-05
// spike's ~9 min silence also overran plain 60 s sleeps, which an HTTP pool cannot cause.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient } from "./client.ts";
import { HttpTimeoutError } from "./errors.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    if (req.url?.startsWith("/slow")) setTimeout(send, 3_000);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("shared HTTP client after a client-side abort", () => {
  it("concurrent GETs right after an aborted write complete promptly, three rounds in a row", async () => {
    const http = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
    for (let round = 0; round < 3; round++) {
      await expect(
        http.request({ method: "POST", url: `${base}/slow`, body: "{}", timeoutMs: 300, idempotent: false }),
      ).rejects.toBeInstanceOf(HttpTimeoutError);
      const t0 = performance.now();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          http.request({ method: "GET", url: `${base}/fast`, idempotent: true }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(performance.now() - t0).toBeLessThan(1_000);
    }
  });
});
