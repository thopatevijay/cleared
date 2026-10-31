// M2-03 test support: the synthetic sample pack (fixtures/samples/evidence) stored exactly as the M2-01
// intake stores it (files sniffed, re-encoded, text layer extracted; text normalised), plus the
// `evidence.added` event and a consumer context for calling the job directly.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, type Exchange, type Logger } from "@cleared/adapters";
import { createPostgresBlobStore, evidenceSha256, prepareEvidenceFile } from "@cleared/adapters/files";
import { FIXTURES_DIR, loadFixture } from "@cleared/adapters/testing/fixture";
import {
  EvidenceAddedEvent,
  FactsSchema,
  normaliseEvidenceText,
  type Facts,
  WorkspaceIdSchema,
  type Instant,
  type SellerEvidenceKind,
  type WorkspaceId,
} from "@cleared/core";
import { evidenceRepo, forWorkspace, platform, withTransaction, type Db } from "@cleared/db";

export interface Sample {
  readonly file: string;
  readonly kind: SellerEvidenceKind;
}

/** The sample pack, in fixture order (`fixtures/openai/extract-v1/<name>.json`). */
export const SAMPLES = {
  "brief-logo": { file: "brief-logo.txt", kind: "scope" },
  "chat-logo": { file: "chat-logo.txt", kind: "communication" },
  "delivery-logo": { file: "delivery-logo.pdf", kind: "delivery" },
  "screenshot-logo": { file: "screenshot-logo.png", kind: "delivery" },
  "chat-delivery-events": { file: "chat-delivery-events.txt", kind: "communication" },
  "receipt-shipping": { file: "receipt-shipping.png", kind: "shipment" },
} as const satisfies Record<string, Sample>;
export type SampleName = keyof typeof SAMPLES;
export const SAMPLE_NAMES = Object.keys(SAMPLES) as SampleName[];

export const fixtureName = (name: SampleName): string => `openai/extract-v1/${name}`;

export async function newWorkspace(db: Db, llmBudgetUsd?: string): Promise<WorkspaceId> {
  const row = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
    ...(llmBudgetUsd === undefined ? {} : { llmBudgetUsd }),
  });
  return WorkspaceIdSchema.parse(row.id);
}

/** A payment and its pack (`collecting`, as after the first evidence item). */
export async function newPack(db: Db, ws: WorkspaceId): Promise<string> {
  const repos = forWorkspace(db, ws);
  const payment = await repos.payments.insert({
    captureId: randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(),
    amount: "240.00",
    currency: "USD",
    status: "COMPLETED",
    source: "webhook",
  });
  const pack = await repos.proofPacks.insert({ paymentId: payment.id, state: "collecting" });
  return pack.id;
}

/** Stores one sample the way M2-01's intake does and returns the evidence item id. */
export async function addSample(db: Db, ws: WorkspaceId, packId: string, name: SampleName): Promise<string> {
  const { file, kind } = SAMPLES[name];
  const raw = readFileSync(join(FIXTURES_DIR, "samples/evidence", file));
  const repo = evidenceRepo(db, ws);
  return withTransaction(db, async (tx) => {
    if (file.endsWith(".txt")) {
      const text = normaliseEvidenceText(raw.toString("utf8"));
      const item = await repo.items.insert(
        { packId, kind, sha256: evidenceSha256({ kind: "text", text }), text },
        tx,
      );
      return item.id;
    }
    const prepared = await prepareEvidenceFile(new Uint8Array(raw));
    if (!prepared.ok) throw new Error(`sample ${name}: ${prepared.error.code}`);
    const p = prepared.value;
    const blob = await createPostgresBlobStore(db).put({ workspaceId: ws, bytes: p.bytes, mime: p.mime }, tx);
    const item = await repo.items.insert({ packId, kind, blobId: blob.id, sha256: p.sha256, text: p.text }, tx);
    return item.id;
  });
}

export function addedEvent(ws: WorkspaceId, packId: string, itemId: string, kind: SellerEvidenceKind) {
  return EvidenceAddedEvent.parse({
    type: "evidence.added",
    version: 1,
    workspaceId: ws,
    occurredAt: new Date().toISOString() as Instant,
    data: { packId, evidenceItemId: itemId, kind, sha256: "0".repeat(64) },
  });
}

export const silentLog: Logger = createLogger({ service: "worker-test", level: "silent" });

// ---- fixtures ------------------------------------------------------------------------------------

/** The `facts@v1` answer recorded in a fixture (the Responses API `output_text` of its message). */
export function recordedFacts(name: SampleName): Facts {
  const body = loadFixture(fixtureName(name)).response.body as {
    output: { type: string; content?: { type: string; text?: string }[] }[];
  };
  const text = body.output
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .find((c) => c.type === "output_text")?.text;
  if (text === undefined) throw new Error(`fixture ${name}: no output_text`);
  return FactsSchema.parse(JSON.parse(text));
}

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

/** What the live proof compares: the sets of party roles and names, amounts and delivery event kinds. */
export function factSet(f: Facts): { parties: string[]; amounts: string[]; events: string[] } {
  return {
    parties: uniq(f.parties.map((p) => `${p.role}:${p.name.trim().toLowerCase()}`)),
    amounts: uniq(f.amounts.map((a) => `${Number(a.value).toFixed(2)} ${a.currency}`)),
    events: uniq(f.delivery_events.map((e) => e.event)),
  };
}

const DATA_URL = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/;
/** Replaces inline base64 payloads (images, PDFs) with a short marker so fixtures stay small (as M0-07). */
function elide(value: unknown): unknown {
  if (typeof value === "string") {
    const m = DATA_URL.exec(value);
    return m ? `data:${m[1] ?? ""};base64,<elided ${String(m[2]?.length ?? 0)} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(elide);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elide(v)]));
  return value;
}

export function elideBody(ex: Exchange): Exchange {
  if (ex.request.body === undefined) return ex;
  return { ...ex, request: { ...ex.request, body: JSON.stringify(elide(JSON.parse(ex.request.body))) } };
}
