// `scope_snapshot.render` (M3-07, ADR 0018): render the pack's scope snapshot PDF and store it as an
// immutable `scope_snapshot` evidence item. Triggered by the seller ("Create scope snapshot") or by a
// `client_ack` item arriving (`evidence.added`, composed after the extract step in the registry).
// - content: the pack's newest scope item (verbatim text + sha256), the payment, the delivery items'
//   metadata, and the newest acknowledgement bound to that scope item (`scope_sha256`); no AI involved
// - idempotent on (pack, input hash): the hash covers everything printed except generated_at, so a re-run
//   with nothing new finds the existing item and writes nothing (unique index backs it)
// - one transaction: blob, evidence row, pack state and the `evidence.added` outbox row (`writeEvidence`)
import { createPostgresBlobStore, renderScopeSnapshotPdf, writeEvidence } from "@cleared/adapters/files";
import {
  EvidenceAddedEvent,
  parseClientAckText,
  ScopeSnapshotRenderJobSchema,
  scopeSnapshotInputHash,
  SCOPE_SNAPSHOT_DELIVERY_KINDS,
  Sha256Schema,
  WorkspaceIdSchema,
  type ScopeSnapshotContent,
  type WorkspaceId,
} from "@cleared/core";
import {
  evidenceRepo,
  forWorkspace,
  platform,
  type Db,
  type EvidenceListRow,
  type ProofPackRow,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface RenderScopeSnapshotDeps {
  readonly db: Db;
  readonly publisher: Pick<Publisher, "emit">;
  readonly now: () => Date;
}

export type SnapshotOutcome =
  | { readonly status: "written"; readonly itemId: string; readonly sha256: string; readonly size: number }
  | { readonly status: "exists"; readonly itemId: string }
  | { readonly status: "not_found" }
  | { readonly status: "no_scope" };

type Ctx = Pick<ConsumeContext, "tx" | "log">;

/** The seller's request (`{workspaceId, packId}`). */
export function renderScopeSnapshotHandler(deps: RenderScopeSnapshotDeps): Handler {
  return async (data, ctx) => {
    const job = ScopeSnapshotRenderJobSchema.parse(data);
    await renderScopeSnapshot(deps, WorkspaceIdSchema.parse(job.workspaceId), job.packId, ctx);
  };
}

/** `evidence.added`: a client's acknowledgement refreshes the snapshot; other kinds are ignored. */
export function snapshotOnAckHandler(deps: RenderScopeSnapshotDeps): Handler {
  return async (data, ctx) => {
    const event = EvidenceAddedEvent.parse(data);
    if (event.data.kind !== "client_ack") return;
    await renderScopeSnapshot(deps, event.workspaceId, event.data.packId, ctx);
  };
}

export async function renderScopeSnapshot(
  deps: RenderScopeSnapshotDeps,
  ws: WorkspaceId,
  packId: string,
  ctx: Ctx,
): Promise<SnapshotOutcome> {
  const repo = evidenceRepo(deps.db, ws);
  await repo.lockWorkspace(ctx.tx); // the order `writeEvidence` takes it in: no deadlock, no duplicate
  const pack = await repo.packs.getOwned(packId, ctx.tx);
  if (pack === null) return { status: "not_found" };
  const content = await snapshotContent(deps.db, ws, pack, ctx.tx);
  if (content === null) {
    ctx.log.info({ packId }, "scope snapshot skipped: no scope item");
    return { status: "no_scope" };
  }
  const inputSha256 = scopeSnapshotInputHash(content);
  const existing = await repo.items.snapshotForInput(pack.id, inputSha256, ctx.tx);
  if (existing !== null) return { status: "exists", itemId: existing.id };
  const pdf = await renderScopeSnapshotPdf({ ...content, generatedAt: deps.now().toISOString() });
  const intake = { db: deps.db, blobs: createPostgresBlobStore(deps.db), publisher: deps.publisher, now: deps.now };
  const item = await writeEvidence(intake, ctx.tx, ws, pack.id, {
    type: "file",
    kind: "scope_snapshot",
    file: { mime: "application/pdf", bytes: pdf.bytes, size: pdf.size, sha256: Sha256Schema.parse(pdf.sha256), text: null },
    inputSha256,
  });
  ctx.log.info({ packId, itemId: item.id, sha256: pdf.sha256, size: pdf.size }, "scope snapshot written");
  return { status: "written", itemId: item.id, sha256: pdf.sha256, size: pdf.size };
}

const iso = (d: Date): string => d.toISOString();

/** What the snapshot prints (without generated_at); null when the pack has no scope item. */
export async function snapshotContent(
  db: Db,
  ws: WorkspaceId,
  pack: ProofPackRow,
  tx: Tx,
): Promise<ScopeSnapshotContent | null> {
  const items = (await evidenceRepo(db, ws).items.listForPack(pack.id, tx)).toReversed(); // oldest first
  const scope = items.findLast((i) => i.kind === "scope");
  if (scope === undefined) return null;
  const [payment, workspace] = await Promise.all([
    forWorkspace(db, ws).payments.get(pack.paymentId, tx),
    platform(db).workspaces.get(ws, tx),
  ]);
  if (payment === null) return null;
  return {
    packId: pack.id,
    payment: { captureId: payment.captureId, amount: payment.amount, currency: payment.currency, date: iso(payment.createdAt) },
    scope: { itemId: scope.id, sha256: Sha256Schema.parse(scope.sha256), text: scope.text },
    delivery: items
      .filter((i) => (SCOPE_SNAPSHOT_DELIVERY_KINDS as readonly string[]).includes(i.kind))
      .map((i) => ({ kind: i.kind, createdAt: iso(i.createdAt), sha256: Sha256Schema.parse(i.sha256) })),
    ack: ackFor(items, scope.sha256),
    timeZone: workspace?.timezone ?? "UTC",
  };
}

/** The newest acknowledgement of exactly this scope item (an ack of an earlier scope does not count). */
function ackFor(items: readonly EvidenceListRow[], scopeSha256: string): ScopeSnapshotContent["ack"] {
  for (const item of items.toReversed()) {
    if (item.kind !== "client_ack" || item.text === null) continue;
    const ack = parseClientAckText(item.text);
    if (ack?.scopeSha256 !== scopeSha256) continue;
    const { typedName, acceptedAt, ip, userAgent } = ack;
    return { typedName, acceptedAt, ip, userAgent, sha256: Sha256Schema.parse(item.sha256) };
  }
  return null;
}
