import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "./index.ts";

describe("@cleared/core", () => {
  it("exposes its package name", () => {
    expect(CORE_PACKAGE).toBe("@cleared/core");
  });
});
