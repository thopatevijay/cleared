// M4-05 caps: the demo caps default to 3 per IP per day and 200 globally, and a client can't step around
// the per-IP cap by forging `X-Forwarded-For`: only the hop Render's proxy appends (the LAST one) or
// Render's `True-Client-IP` (set at its Cloudflare edge) count. The per-IP and global refusals themselves
// are proven in test/auth/demo.int.test.ts; the LLM caps in packages/core (reservation), apps/worker
// (no request leaves at a cap) and app/api/scenarios (the seller-facing message).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authConfigFromEnv } from "../../src/server/config.ts";
import { clientIp } from "../../src/server/client-ip.ts";
import { postDemo } from "../../src/server/handlers/demo.ts";
import { freshIp, ORIGIN, req, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

const spoof = (): string => `198.51.100.${String(randomBytes(1)[0])}`;

describe("demo caps: defaults and the trusted client-IP header", () => {
  it("defaults: 3 demo workspaces per IP per day, 200 live globally", () => {
    const c = authConfigFromEnv({ APP_BASE_URL: ORIGIN, SESSION_SECRET: "s".repeat(32) });
    expect({ perIp: c.demoPerIpPerDay, global: c.demoGlobalMax }).toEqual({ perIp: 3, global: 200 });
  });

  it("a forged X-Forwarded-For prefix never changes the client IP; True-Client-IP wins", () => {
    const h = (xff: string, tci?: string) =>
      new Headers({ "x-forwarded-for": xff, ...(tci === undefined ? {} : { "true-client-ip": tci }) });
    expect(clientIp(h(`${spoof()}, ${spoof()}, 10.0.0.7`))).toBe("10.0.0.7");
    expect(clientIp(h("1.1.1.1, 10.0.0.7"))).toBe(clientIp(h("8.8.8.8, 9.9.9.9, 10.0.0.7")));
    expect(clientIp(h(`${spoof()}, 10.0.0.9`, "203.0.113.5"))).toBe("203.0.113.5");
  });
});

describe.skipIf(!dbAvailable)("demo caps: X-Forwarded-For spoofing (integration)", () => {
  it("4 demos from one proxy-seen IP, each with a different forged first hop → the 4th is 429", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = req("/api/demo", { headers: { "x-forwarded-for": `${spoof()}, ${spoof()}, ${ip}` } });
      codes.push((await postDemo(r, deps)).status);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  it("the same True-Client-IP behind different proxy hops is one bucket: the 4th is 429", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = req("/api/demo", { headers: { "true-client-ip": ip, "x-forwarded-for": `${ip}, ${freshIp()}` } });
      codes.push((await postDemo(r, deps)).status);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
  });
});
