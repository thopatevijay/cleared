// Replay recorded fixtures through msw. Each fixture answers ONE matching request (method + URL,
// and `PayPal-Request-Id` when the fixture recorded one), in the order given. A request with no
// remaining fixture gets a network error (`HttpResponse.error()`) and is listed by `unmatched()`.
// It must not return `undefined`: in msw 3 a matched handler that returns nothing is a
// passthrough to the real network, so `onUnhandledFrame: "error"` never fires for it (BL-01).
// `onUnhandledFrame: "error"` still covers anything the catch-all does not match.
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { loadFixture, responseText, type Fixture } from "./fixture.ts";

export interface Replay {
  readonly server: SetupServer;
  /** Fixture names not yet served; assert empty to prove the whole recording was exercised. */
  unused(): string[];
  /** `METHOD url` of every request that had no remaining fixture (each one failed fast). */
  unmatched(): string[];
  close(): void;
}

interface Slot {
  readonly name: string;
  readonly fixture: Fixture;
  used: boolean;
}

export function replayHandlers(slots: readonly Slot[], misses: string[] = []): RequestHandler[] {
  return [
    http.all("*", ({ request }) => {
      const requestId = request.headers.get("paypal-request-id");
      const slot = slots.find((s) => !s.used && matches(s.fixture, request.method, request.url, requestId));
      if (slot === undefined) {
        misses.push(`${request.method} ${request.url}`);
        return HttpResponse.error(); // never `undefined`: that is a passthrough in msw 3
      }
      slot.used = true;
      const { response } = slot.fixture;
      return new HttpResponse(response.body === null ? null : responseText(slot.fixture), {
        status: response.status,
        headers: response.headers,
      });
    }),
  ];
}

function matches(f: Fixture, method: string, url: string, requestId: string | null): boolean {
  if (f.request.method !== method || f.request.url !== url) return false;
  const recorded = f.request.headers["paypal-request-id"];
  return recorded === undefined || requestId === null || recorded === requestId;
}

/** Starts an msw server that serves the named fixtures (`paypal/orders/create-goods-a`, …). */
export function startReplay(names: readonly string[]): Replay {
  const slots: Slot[] = names.map((name) => ({ name, fixture: loadFixture(name), used: false }));
  const misses: string[] = [];
  const server = setupServer(...replayHandlers(slots, misses));
  server.listen({ onUnhandledFrame: "error" });
  return {
    server,
    unused: () => slots.filter((s) => !s.used).map((s) => s.name),
    unmatched: () => [...misses],
    close: () => {
      server.close();
    },
  };
}
