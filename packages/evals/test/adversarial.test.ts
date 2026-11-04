// Adversarial cases (M4-02, ≥ 15), in replay mode: the scripted ones need no recording; the recorded ones
// (six chat injections against their clean twins, one image) replay the live eval's recordings.
import { describe, expect, it } from "vitest";
import { injectionTwinCase, imageInjectionCase, SCRIPTED_CASES } from "../src/adversarial.ts";
import { loadItems } from "../src/evaluate.ts";
import { createRecorder } from "../src/recording.ts";
import type { EvalDeps } from "../src/sets.ts";
import { createEvalStore, evalConfig } from "../src/store.ts";

const injectionItems = loadItems("scope", "all").filter((i) => i.injection);

function replayDeps(): EvalDeps {
  return { recorder: createRecorder({ mode: "replay" }), store: createEvalStore(), config: evalConfig({}, 1_000_000) };
}

describe("adversarial set", () => {
  it("has at least 15 cases", () => {
    expect(SCRIPTED_CASES.length + injectionItems.length + 1).toBeGreaterThanOrEqual(15);
    expect(injectionItems.length).toBe(6);
  });

  it.each(SCRIPTED_CASES.map((c) => [c.id, c] as const))("scripted: %s", async (_id, c) => {
    const r = await c.run();
    expect(r.pass, r.detail).toBe(true);
  });

  it.each(injectionItems.map((i) => [i.id, i] as const))("recorded: %s verdicts equal its clean twin's", async (_id, item) => {
    const deps = replayDeps();
    const r = await injectionTwinCase(deps, item);
    expect(deps.recorder.stale.map((s) => s.message)).toEqual([]);
    expect(r.pass, r.detail).toBe(true);
  });

  it("recorded: an instruction inside an image is reported, not obeyed", async () => {
    const deps = replayDeps();
    const r = await imageInjectionCase(deps);
    expect(deps.recorder.stale.map((s) => s.message)).toEqual([]);
    expect(r.pass, r.detail).toBe(true);
  });
});
