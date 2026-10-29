// The replay must never reach the network: an unrecorded request fails fast and is listed.
import { afterEach, describe, expect, it } from "vitest";
import { startReplay, type Replay } from "./replay.ts";

let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

const UNRECORDED = "https://api-m.sandbox.paypal.com/v2/checkout/orders/NOTRECORDED1";

describe("startReplay", () => {
  it("an unrecorded request is a network error, not a passthrough", async () => {
    replay = startReplay([]);
    const started = Date.now();
    await expect(fetch(UNRECORDED)).rejects.toThrow(TypeError);
    // A passthrough reaches the real host (seconds, or a hang under the Bash sandbox).
    expect(Date.now() - started).toBeLessThan(500);
    expect(replay.unmatched()).toEqual([`GET ${UNRECORDED}`]);
  });

  it("a fixture answers once; the repeat is unmatched", async () => {
    replay = startReplay(["paypal/oauth/token"]);
    const url = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
    const init = { method: "POST", body: "grant_type=client_credentials" };
    expect((await fetch(url, init)).status).toBe(200);
    await expect(fetch(url, init)).rejects.toThrow(TypeError);
    expect(replay.unused()).toEqual([]);
    expect(replay.unmatched()).toEqual([`POST ${url}`]);
  });
});
