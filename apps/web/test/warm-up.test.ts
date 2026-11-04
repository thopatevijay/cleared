// BL-01 6609550494: the boot self-ping that loads the route chunks before the first real requests.
import { describe, expect, it } from "vitest";
import { warmUp, warmUpUrl } from "../src/server/warm-up.ts";

const noSleep = () => Promise.resolve();

describe("warmUpUrl", () => {
  it("pings the server's own /readyz on PORT in production only", () => {
    expect(warmUpUrl({ NODE_ENV: "production", PORT: "10000" })).toBe("http://127.0.0.1:10000/readyz");
    expect(warmUpUrl({ NODE_ENV: "production" })).toBe("http://127.0.0.1:3000/readyz");
    expect(warmUpUrl({ NODE_ENV: "development", PORT: "3000" })).toBeNull();
    expect(warmUpUrl({ NODE_ENV: "test" })).toBeNull();
  });

  it("refuses a PORT that isn't a number (never a host or path from the environment)", () => {
    expect(warmUpUrl({ NODE_ENV: "production", PORT: "evil.example/x" })).toBeNull();
  });
});

describe("warmUp", () => {
  it("retries until the server listens, then stops after one answer", async () => {
    const calls: string[] = [];
    const ok = await warmUp("http://127.0.0.1:1/readyz", {
      sleep: noSleep,
      fetch: (u) => {
        calls.push(u);
        return calls.length < 3 ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve({});
      },
    });
    expect([ok, calls.length]).toEqual([true, 3]);
  });

  it("gives up quietly after its tries and never throws", async () => {
    let n = 0;
    const ok = await warmUp("http://127.0.0.1:1/readyz", {
      tries: 4,
      sleep: noSleep,
      fetch: () => {
        n += 1;
        return Promise.reject(new Error("ECONNREFUSED"));
      },
    });
    expect([ok, n]).toEqual([false, 4]);
  });
});
