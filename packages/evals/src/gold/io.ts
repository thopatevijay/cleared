// Paths and JSONL I/O for the gold sets. One JSON object per line, written in a fixed key order, so a
// rewrite of unchanged data is byte-identical.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { GoldSet } from "./schema.ts";

export const GOLD_DIR = fileURLToPath(new URL("../../gold/", import.meta.url));
export const DRAFTS_DIR = join(GOLD_DIR, "drafts");
export const REVIEWS_DIR = join(GOLD_DIR, "reviews");
export const SPEND_FILE = join(GOLD_DIR, "SPEND.md");
export const DISAGREEMENTS_FILE = join(GOLD_DIR, "disagreements.jsonl");

export const draftFile = (set: GoldSet, dir = DRAFTS_DIR): string => join(dir, `${set}.jsonl`);
export const reviewFile = (set: GoldSet): string => join(REVIEWS_DIR, `${set}.jsonl`);
export const goldFile = (set: GoldSet): string => join(GOLD_DIR, `${set}.jsonl`);

export function readJsonl<S extends z.ZodType>(file: string, schema: S): z.infer<S>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${file}:${String(i + 1)}: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function writeJsonl(file: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""));
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** One value per set, typed by set. */
export function bySet<T>(f: (set: GoldSet) => T): Record<GoldSet, T> {
  return { extraction: f("extraction"), scope: f("scope"), holds: f("holds") };
}

/** `--flag value` from argv, or undefined. */
export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
