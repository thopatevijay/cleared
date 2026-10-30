// M1-07: a browser following a used or expired link lands on /<locale>/signin/expired; API clients keep
// M1-05's JSON 400.
import { describe, expect, it } from "vitest";
import { getVerify } from "../../src/server/handlers/verify.ts";
import { ORIGIN, req, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

const bad = `/api/auth/verify?token=${"x".repeat(43)}`;

describe.skipIf(!dbAvailable)("verify: expired-link page", () => {
  it("text/html → 303 to the expired page in the browser's language", async () => {
    const hi = await getVerify(
      req(bad, { method: "GET", headers: { accept: "text/html,*/*", "accept-language": "hi-IN,hi;q=0.9" } }),
      testDeps(),
    );
    expect(hi.status).toBe(303);
    expect(hi.headers.get("location")).toBe(`${ORIGIN}/hi/signin/expired`);
    const en = await getVerify(req(bad, { method: "GET", headers: { accept: "text/html" } }), testDeps());
    expect(en.headers.get("location")).toBe(`${ORIGIN}/en/signin/expired`);
  });

  it("no text/html → the JSON 400 envelope", async () => {
    const res = await getVerify(req(bad, { method: "GET" }), testDeps());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_link");
  });
});
