import { describe, expect, it } from "vitest";
import { correlationIdOrNew, currentContext, withContext } from "./context.ts";
import { createLogger } from "./log.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    service: "test",
    destination: { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  });
  return { log, lines };
}

describe("obs context + logger", () => {
  it("adds service, level label and the current context to every line", async () => {
    const { log, lines } = capture();
    log.info("outside");
    await withContext({ correlationId: "c-1", workspaceId: "w-1" }, async () => {
      await Promise.resolve();
      log.info({ extra: 1 }, "inside");
    });
    expect(lines[0]).toMatchObject({ service: "test", level: "info", msg: "outside" });
    expect(lines[0]).not.toHaveProperty("correlationId");
    expect(lines[1]).toMatchObject({ msg: "inside", correlationId: "c-1", workspaceId: "w-1", extra: 1 });
  });

  it("correlationIdOrNew returns the context's id, or a fresh uuid", () => {
    expect(currentContext()).toBeUndefined();
    expect(correlationIdOrNew()).toMatch(/^[0-9a-f-]{36}$/);
    expect(withContext({ correlationId: "c-2" }, correlationIdOrNew)).toBe("c-2");
  });
});
