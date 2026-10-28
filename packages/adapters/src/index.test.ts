import { describe, expect, it } from "vitest";
import { ADAPTERS_PACKAGE, dependsOn } from "./index.ts";

describe("@cleared/adapters", () => {
  it("depends inward on the core", () => {
    expect(ADAPTERS_PACKAGE).toBe("@cleared/adapters");
    expect(dependsOn).toEqual(["@cleared/core"]);
  });
});
