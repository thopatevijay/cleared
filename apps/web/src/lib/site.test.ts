import { describe, expect, it } from "vitest";
import { pageTitle } from "./site.ts";

describe("pageTitle", () => {
  it("uses the product name alone or after a section", () => {
    expect(pageTitle()).toBe("Cleared");
    expect(pageTitle("Payments")).toBe("Payments · Cleared");
  });
});
