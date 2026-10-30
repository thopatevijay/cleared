import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client.ts";
import { createPayPalOrdersClient } from "../paypal/orders.ts";
import { createTokenProvider } from "../paypal/token.ts";
import { startReplay, type Replay } from "../testing/replay.ts";
import { withContext } from "./context.ts";
import { routeTemplate } from "./http-logging.ts";
import { createLogger } from "./log.ts";

let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

describe("obs outbound-call logging (M1-08)", () => {
  it("templates routes: ids become :id, the query string is dropped", () => {
    expect(routeTemplate("https://api-m.sandbox.paypal.com/v2/payments/captures/6BC19320SY177903T?x=1")).toBe(
      "/v2/payments/captures/:id",
    );
    expect(routeTemplate("https://api-m.sandbox.paypal.com/v1/oauth2/token")).toBe("/v1/oauth2/token");
    expect(routeTemplate("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345678")).toBe(
      "/v1/customer/disputes/:id",
    );
  });

  it("logs each PayPal call with vendor, route, status, duration, attempt, correlation id and debug id", async () => {
    replay = startReplay(["paypal/oauth/token", "paypal/orders/get-capture-a"]);
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({
      service: "worker",
      destination: { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
    });
    const http = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0, log });
    const tokens = createTokenProvider({
      http,
      baseUrl: "https://api-m.sandbox.paypal.com",
      credentials: { clientId: "replay-http-logging", clientSecret: "replay" },
      cache: new Map(),
    });
    const pp = createPayPalOrdersClient({ http, tokens });
    const cid = "6f1c7c1e-3b7a-4c55-9a59-7d3f7b0f8d11";
    await withContext({ correlationId: cid }, () => pp.getCapture("6BC19320SY177903T"));

    const calls = lines.filter((l) => l["msg"] === "outbound call");
    expect(calls.map((l) => l["route"])).toEqual(["/v1/oauth2/token", "/v2/payments/captures/:id"]);
    expect(calls[1]).toMatchObject({
      vendor: "paypal",
      method: "GET",
      status: 200,
      attempt: 1,
      correlationId: cid,
      paypalDebugId: "f561822f3f12c",
    });
    expect(typeof calls[1]?.["durationMs"]).toBe("number");
    expect(JSON.stringify(lines)).not.toMatch(/Bearer |Basic /);
  });
});
