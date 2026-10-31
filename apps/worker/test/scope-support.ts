// M2-04 test support: the M0-07 spike's sample packs stored as M2-01's intake stores them (oldest item first,
// so the block refs are E1 brief, E2 chat, E3.. deliveries, as in the recordings), each item settled with a
// facts row the way M2-03 leaves it, and the `pack.extracted` event that triggers the scope check.
import { randomUUID } from "node:crypto";
import {
  EXTRACT_PROMPT,
  FactsSchema,
  PackExtractedEvent,
  type Facts,
  type Instant,
  type SellerEvidenceKind,
  type WorkspaceId,
} from "@cleared/core";
import { extractedFactsRepo, withTransaction, type Db } from "@cleared/db";
import { addFile, recordedFacts, SAMPLE_NAMES, type SampleName } from "./extract-support.ts";

export const SPIKE_PACKS = {
  logo: ["brief-logo.txt", "chat-logo.txt", "delivery-logo.pdf", "screenshot-logo.png"],
  "logo-control": ["brief-logo.txt", "chat-logo-control.txt", "delivery-logo.pdf", "screenshot-logo.png"],
  translation: ["brief-translation.txt", "chat-translation.txt", "delivery-translation.pdf"],
  website: ["brief-website.txt", "chat-website.txt", "screenshot-website.png"],
} as const;
export type SpikePack = keyof typeof SPIKE_PACKS;

/** The M0-07 runs and the pack each was recorded on. */
export const SPIKE_RUNS: Readonly<Record<string, SpikePack>> = {
  r1: "logo",
  r2: "translation",
  r3: "website",
  r4: "logo",
  r5: "logo",
  c1: "logo-control",
};

export function kindOf(file: string): SellerEvidenceKind {
  if (file.startsWith("brief-")) return "scope";
  if (file.startsWith("chat-")) return "communication";
  return "delivery";
}

const EMPTY_FACTS: Facts = FactsSchema.parse({
  parties: [],
  amounts: [],
  dates: [],
  deliverables: [],
  delivery_events: [],
  shipment: null,
  instruction_like_lines: [],
});

/** The recorded extract-v1 facts when the file has a fixture (the logo pack), else an empty facts row. */
function factsFor(file: string, itemId: string): Facts {
  const name = file.replace(/\.(txt|pdf|png)$/, "") as SampleName;
  const facts = SAMPLE_NAMES.includes(name) ? recordedFacts(name) : EMPTY_FACTS;
  const re = <T extends { evidence_item_id: string }>(f: T): T => ({ ...f, evidence_item_id: itemId });
  return {
    ...facts,
    parties: facts.parties.map(re),
    amounts: facts.amounts.map(re),
    dates: facts.dates.map(re),
    deliverables: facts.deliverables.map(re),
    delivery_events: facts.delivery_events.map(re),
    shipment: facts.shipment ? re(facts.shipment) : null,
  };
}

/** Marks one item's extraction finished, as M2-03 does: a facts row for `extract@v1`. */
export async function settle(db: Db, ws: WorkspaceId, itemId: string, file: string): Promise<string> {
  const row = await withTransaction(db, (tx) =>
    extractedFactsRepo(db, ws).insert(
      {
        evidenceItemId: itemId,
        facts: factsFor(file, itemId),
        model: "gpt-6-luna",
        runId: null,
        promptVersion: EXTRACT_PROMPT.id,
      },
      tx,
    ),
  );
  if (!row) throw new Error(`facts for ${file} already exist`);
  return row.id;
}

/** Stores the files in order and settles each; returns the item ids (index i is block ref E{i+1}). */
export async function storePack(
  db: Db,
  ws: WorkspaceId,
  packId: string,
  files: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    const id = await addFile(db, ws, packId, file, kindOf(file));
    await settle(db, ws, id, file);
    ids.push(id);
  }
  return ids;
}

export function extractedEvent(ws: WorkspaceId, packId: string, itemId: string) {
  return PackExtractedEvent.parse({
    type: "pack.extracted",
    version: 1,
    workspaceId: ws,
    occurredAt: new Date().toISOString() as Instant,
    data: { packId, evidenceItemId: itemId, factsId: randomUUID(), runId: randomUUID() },
  });
}
