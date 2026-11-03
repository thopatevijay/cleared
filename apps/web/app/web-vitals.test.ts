import { describe, expect, it } from "vitest";
import { routePattern } from "./web-vitals.tsx";

describe("routePattern (M4-04 web vitals)", () => {
  it("keeps route words and replaces ids and tokens", () => {
    expect(routePattern("/en/payments")).toBe("/en/payments");
    expect(routePattern("/hi/holds/7c1e2f90-4b1a-4c55-9d1e-0a2b3c4d5e6f")).toBe("/hi/holds/:id");
    expect(routePattern("/en/payments/0b6f8e2a-1111-4c55-9d1e-0a2b3c4d5e6f/pack")).toBe(
      "/en/payments/:id/pack",
    );
    expect(routePattern("/en/ack/AbCdEfGhIjKlMnOpQrStUvWxYz_-AbCdEfGhIjKlMnOpQ")).toBe("/en/ack/:id");
  });
});
