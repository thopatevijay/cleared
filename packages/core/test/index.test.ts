import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";

describe("@cleared/core", () => {
  it("exposes its package name", () => {
    expect(core.CORE_PACKAGE).toBe("@cleared/core");
  });

  it("re-exports the public API the handoff names", () => {
    for (const name of [
      "mapCapture",
      "isHold",
      "applyMirror",
      "resolveOwner",
      "canExecute",
      "canonicalJson",
      "DomainEventSchema",
      "ErrorEnvelopeSchema",
      "parseMoney",
      "transition",
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });
});
