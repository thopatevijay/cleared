// M3-07 fixture packs (`fixtures/packs/scope-snapshot-*.json`): a scope snapshot document each (synthetic
// people and orders; the English scope is the M0 logo brief verbatim).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "@cleared/adapters/testing/fixture";
import { ScopeSnapshotContentSchema, type ScopeSnapshotDocument } from "@cleared/core";
import { z } from "zod";

export const SNAPSHOT_FIXTURES = ["en-ack", "en-no-ack", "hi"] as const;
export type SnapshotFixture = (typeof SNAPSHOT_FIXTURES)[number];

const DocumentSchema = ScopeSnapshotContentSchema.extend({ generatedAt: z.iso.datetime() });

export function snapshotFixture(name: SnapshotFixture): ScopeSnapshotDocument {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, "packs", `scope-snapshot-${name}.json`), "utf8"));
  return DocumentSchema.parse(raw);
}

/** Collapses whitespace: wrapped lines extract with line breaks where the source had spaces. */
export const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
