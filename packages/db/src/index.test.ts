import { describe, expect, it } from "vitest";
import { DB_PACKAGE, dependsOn } from "./index.ts";

describe("@cleared/db", () => {
  it("depends inward on the core", () => {
    expect(DB_PACKAGE).toBe("@cleared/db");
    expect(dependsOn).toEqual(["@cleared/core"]);
  });
});
