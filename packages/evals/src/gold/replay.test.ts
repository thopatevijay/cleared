// The recorded generator and reviewer answers replay without spend (AC 6): drafting reproduces the
// committed drafts byte for byte, and every review re-derives from its fixture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createReplayCaller } from "./ai.ts";
import { draftFile, DRAFTS_DIR, readJsonl, reviewFile } from "./io.ts";
import { reviewSpec, toReview } from "./review.ts";
import { DraftItemSchema, PROD_MODEL, ReviewSchema, SETS } from "./schema.ts";

const DRAFT_CLI = fileURLToPath(new URL("./draft.ts", import.meta.url));

describe("gold replay (no network, no spend)", () => {
  it("eval:draft --replay reproduces the committed drafts byte for byte", () => {
    const out = mkdtempSync(join(tmpdir(), "gold-"));
    execFileSync(process.execPath, [DRAFT_CLI, "--replay", "--out", out], { env: { PATH: process.env.PATH ?? "" } });
    for (const f of [...SETS.map((s) => `${s}.jsonl`), "generator.json"]) {
      expect(readFileSync(join(out, f), "utf8")).toBe(readFileSync(join(DRAFTS_DIR, f), "utf8"));
    }
  }, 60_000);

  it("every committed review re-derives from its recording, by a non-production model", async () => {
    const caller = createReplayCaller();
    for (const set of SETS) {
      const reviews = readJsonl(reviewFile(set), ReviewSchema);
      const drafts = readJsonl(draftFile(set), DraftItemSchema);
      expect(reviews.map((r) => r.item_id)).toEqual(drafts.map((d) => d.id));
      for (const [i, d] of drafts.entries()) {
        const res = await caller.call(reviewSpec(d));
        expect(toReview(d, res.value, res.model)).toEqual(reviews[i]);
        expect(res.model).not.toBe(PROD_MODEL[set]);
      }
    }
  }, 60_000);
});
