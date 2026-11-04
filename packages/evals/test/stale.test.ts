// AC 2: a one-character change to the check_scope prompt makes replay fail with "recording stale". The
// recordings are made here, by the recorder's live path against a fake OpenAI endpoint (msw) in a temp dir,
// so the test needs no network, no key and no committed recording.
import { CHECK_SCOPE_PROMPT, checkScopeWorkflow, definePrompt } from "@cleared/core";
import { describe, expect, it } from "vitest";
import { loadItems } from "../src/evaluate.ts";
import { createRecorder, STALE_MESSAGE } from "../src/recording.ts";
import { scopeItem, type EvalDeps } from "../src/sets.ts";
import { createEvalStore, evalConfig } from "../src/store.ts";
import { fakeOpenAi, scopeAnswers, tempDir } from "./support.ts";

const item = loadItems("scope", "test").find((i) => !i.injection);
if (!item) throw new Error("no scope test item");

function deps(mode: "live" | "replay", dir: string, changed = false): EvalDeps {
  const recorder = createRecorder({ mode, dir, ...(mode === "live" ? { apiKey: "sk-test-not-a-key" } : {}) });
  const workflows = changed
    ? {
        checkScope: {
          ...checkScopeWorkflow,
          // one character more, same prompt id: the input hash (the cache key) is unchanged
          prompt: definePrompt(CHECK_SCOPE_PROMPT.id, `${CHECK_SCOPE_PROMPT.system}.`),
        },
      }
    : {};
  return { recorder, store: createEvalStore(), config: evalConfig({}, 1), workflows };
}

describe("recording stale (AC 2)", () => {
  const dir = tempDir();

  it("records through the live path, then replays the same item offline", async () => {
    const fake = fakeOpenAi(scopeAnswers(item));
    try {
      const live = await scopeItem(deps("live", dir), item);
      expect(live.run.status).toBe("succeeded");
      expect(fake.requests()).toBe(item.documents.length + 2); // extract per document, pass 1, pass 2
    } finally {
      fake.close();
    }
    const d = deps("replay", dir);
    const replay = await scopeItem(d, item);
    expect(d.recorder.stale).toEqual([]);
    expect(replay.run.status).toBe("succeeded");
    expect(replay.lines?.map((l) => l.verdict)).toEqual(item.hypotheses.map((h) => (h.spans[0] ? "met" : "unverifiable")));
  });

  it("fails with 'recording stale' when one character of the check_scope prompt changes", async () => {
    const d = deps("replay", dir, true);
    const out = await scopeItem(d, item);
    expect(out.lines).toBeNull();
    expect(d.recorder.stale.length).toBeGreaterThan(0);
    expect(d.recorder.stale[0]?.message).toContain(STALE_MESSAGE);
    expect(d.recorder.stale[0]?.message).toContain("check_scope/");
  });

  it("fails with 'recording stale' when there is no recording at all", async () => {
    const d = deps("replay", tempDir());
    await scopeItem(d, item);
    expect(d.recorder.stale[0]?.message).toContain(`${STALE_MESSAGE} (extract/`);
  });
});
