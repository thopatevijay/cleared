import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/healthz/route.ts";
import { healthz } from "./healthz.ts";

describe("healthz", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the Render commit", () => {
    expect(healthz({ RENDER_GIT_COMMIT: "abc123" })).toEqual({ ok: true, commit: "abc123" });
  });

  it("reports a null commit outside Render", () => {
    expect(healthz({})).toEqual({ ok: true, commit: null });
    expect(healthz({ RENDER_GIT_COMMIT: "" })).toEqual({ ok: true, commit: null });
  });

  it("GET /healthz answers 200 JSON, uncached, with the commit", async () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "0123456789abcdef");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, commit: "0123456789abcdef" });
  });
});
