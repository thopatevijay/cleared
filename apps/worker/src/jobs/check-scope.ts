// `pack.extracted` consumer (M2-04): run `check_scope@v1` on the pack through the M2-02 harness, then write
// the check (one `scope_checks` row per line), move the pack to `checked` and emit `pack.checked`, all in the
// consumer's transaction.
// - waits for the pack: while any item's extraction is unfinished (no facts row and no `extract.no_facts`),
//   nothing runs; the last item's `pack.extracted` runs the check over the whole pack.
// - idempotent on (pack, evidence set hash, prompt version): the set hash covers every item (id, sha256)
//   and its facts row, so a re-delivery finds its rows and writes nothing, and new evidence writes the next
//   version (old rows are never edited: the table is append-only).
// - a run without output (degraded, budget, limits, kill switch, invalid output) writes no verdicts: the
//   pack keeps its facts and state, an `audit_log` entry `check_unavailable` records why, and the job is
//   acked (a re-run is a seller action, M2-05).
import { createPostgresBlobStore } from "@cleared/adapters/files";
import {
  canonicalHash,
  CHECK_SCOPE_PROMPT,
  checkScopeWorkflow,
  EXTRACT_PROMPT,
  extractInputFor,
  PackExtractedEvent,
  packStateAfterCheck,
  runWorkflow,
  SCOPE_KINDS,
  storedCitation,
  withEvidenceIds,
  type AgentConfig,
  type AiProvider,
  type CheckedLine,
  type Instant,
  type ProofPackId,
  type ScopeCheckInput,
  type ScopeItemInput,
  type WorkspaceId,
} from "@cleared/core";
import {
  createRunStore,
  evidenceRepo,
  extractedFactsRepo,
  forWorkspace,
  scopeChecksRepo,
  type Db,
  type NewScopeLine,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface CheckScopeDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly provider: AiProvider;
  readonly config: AgentConfig;
  readonly now: () => Date;
}

export type CheckScopeOutcome =
  | {
      readonly status: "written";
      readonly checkVersion: number;
      readonly runId: string;
      readonly lines: number;
    }
  | { readonly status: "exists" }
  | { readonly status: "pending"; readonly awaiting: readonly string[] }
  | { readonly status: "not_found" }
  | { readonly status: "no_scope" }
  | { readonly status: "unavailable"; readonly runStatus: string; readonly runId: string | null };

type ExtractedEvent = ReturnType<typeof PackExtractedEvent.parse>;
type Ctx = Pick<ConsumeContext, "tx" | "log" | "envelope">;

/** The pack as the workflow reads it, plus what maps its block refs back to item uuids. */
interface LoadedPack {
  readonly input: ScopeCheckInput;
  readonly itemIdOf: (ref: string) => string;
  readonly evidenceSetHash: string;
}

export function checkScopeHandler(deps: CheckScopeDeps): Handler {
  return async (data, ctx) => {
    await checkScope(deps, PackExtractedEvent.parse(data), ctx);
  };
}

export async function checkScope(
  deps: CheckScopeDeps,
  event: ExtractedEvent,
  ctx: Ctx,
): Promise<CheckScopeOutcome> {
  const ws = event.workspaceId;
  const { packId } = event.data;
  const checks = scopeChecksRepo(deps.db, ws);
  const awaiting = await checks.itemsAwaitingFacts(packId, EXTRACT_PROMPT.id, ctx.tx);
  if (awaiting.length > 0) {
    ctx.log.info({ packId, awaiting: awaiting.length }, "scope check waits for extraction");
    return { status: "pending", awaiting };
  }
  const pack = await loadPack(deps.db, ws, packId, ctx.tx);
  if (pack === null) return { status: "not_found" };
  if ((await checks.versionFor(packId, pack.evidenceSetHash, CHECK_SCOPE_PROMPT.id, ctx.tx)) !== null)
    return { status: "exists" };
  if (!pack.input.items.some((i) => SCOPE_KINDS.includes(i.kind))) {
    ctx.log.info({ packId }, "scope check skipped: no scope or chat evidence");
    return { status: "no_scope" };
  }
  const out = await runWorkflow(checkScopeWorkflow, pack.input, {
    provider: deps.provider,
    store: createRunStore(deps.db),
    config: deps.config,
    workspaceId: ws,
    correlationId: ctx.envelope.correlationId,
  });
  if ("reason" in out) {
    await recordUnavailable(deps.db, ctx.tx, ws, {
      packId,
      runId: out.runId,
      status: out.status,
      reason: out.reason,
    });
    ctx.log.warn(
      { packId, runId: out.runId, runStatus: out.status, reason: out.reason },
      "scope check unavailable",
    );
    return { status: "unavailable", runStatus: out.status, runId: out.runId };
  }
  return persist(deps, ctx, ws, packId, pack, out.runId, out.output.lines);
}

/** One transaction: the check's rows, the pack's state, `pack.checked`. */
async function persist(
  deps: CheckScopeDeps,
  ctx: Ctx,
  ws: WorkspaceId,
  packId: ProofPackId,
  pack: LoadedPack,
  runId: string,
  lines: readonly CheckedLine[],
): Promise<CheckScopeOutcome> {
  const locked = await evidenceRepo(deps.db, ws).packs.lock(packId, ctx.tx); // versions are serial per pack
  if (!locked) return { status: "not_found" };
  const written = await scopeChecksRepo(deps.db, ws).insertCheck(
    {
      packId,
      evidenceSetHash: pack.evidenceSetHash,
      promptVersion: CHECK_SCOPE_PROMPT.id,
      runId,
      lines: lines.map((l) => toRow(l, pack.itemIdOf)),
    },
    ctx.tx,
  );
  if (written === null) return { status: "exists" }; // a concurrent delivery wrote it first
  const now = deps.now();
  await forWorkspace(deps.db, ws).proofPacks.update(
    packId,
    { state: packStateAfterCheck(locked.state), checkedAt: now },
    ctx.tx,
  );
  await deps.publisher.emit(ctx.tx, {
    type: "pack.checked",
    version: 1,
    workspaceId: ws,
    occurredAt: now.toISOString() as Instant,
    data: { packId, checkedAt: now.toISOString() as Instant },
  });
  ctx.log.info(
    { packId, runId, checkVersion: written.checkVersion, lines: lines.length },
    "scope check written",
  );
  return { status: "written", checkVersion: written.checkVersion, runId, lines: lines.length };
}

function toRow(l: CheckedLine, itemIdOf: (ref: string) => string): NewScopeLine {
  return {
    lineId: l.line_id,
    line: l.requirement,
    verdict: l.verdict,
    modelVerdict: l.model_verdict,
    note: l.note,
    rationale: l.rationale,
    lineCitation: l.line_citation ? storedCitation(l.line_citation, itemIdOf) : null,
    citations: l.citations.map((c) => storedCitation(c, itemIdOf)),
  };
}

/** The pack's items oldest first as `E1..En` (text first, else the file), their facts, and the set hash. */
async function loadPack(db: Db, ws: WorkspaceId, packId: string, tx: Tx): Promise<LoadedPack | null> {
  const repo = evidenceRepo(db, ws);
  if (!(await repo.packs.getOwned(packId, tx))) return null;
  const rows = (await repo.items.listForPack(packId, tx)).reverse();
  const factRows = await extractedFactsRepo(db, ws).listForPack(packId, EXTRACT_PROMPT.id, tx);
  const blobs = createPostgresBlobStore(db);
  const items: ScopeItemInput[] = [];
  const ids: string[] = [];
  for (const row of rows) {
    const blob = row.text === null && row.blobId ? await blobs.get(ws, row.blobId, tx) : null;
    const ref = `E${String(items.length + 1)}`;
    const content = extractInputFor(
      {
        kind: row.kind,
        sha256: row.sha256,
        text: row.text,
        file: blob ? { mime: blob.mime, base64: Buffer.from(blob.bytes).toString("base64") } : null,
      },
      ref,
    )?.content;
    if (!content) continue;
    items.push({ ref, kind: row.kind, sha256: row.sha256, content });
    ids.push(row.id);
  }
  const refOf = new Map(ids.map((id, i) => [id, `E${String(i + 1)}`] as const));
  const idOf = new Map<string, string>(ids.map((id, i) => [`E${String(i + 1)}`, id] as const));
  const facts = factRows
    .filter((f) => refOf.has(f.evidenceItemId))
    .map((f) => ({
      ref: refOf.get(f.evidenceItemId) ?? "",
      facts: withEvidenceIds(f.facts, (id) => refOf.get(id) ?? id),
    }));
  const factsIdOf = new Map(factRows.map((f) => [f.evidenceItemId, f.id] as const));
  return {
    input: { items, facts },
    itemIdOf: (ref) => {
      const id = idOf.get(ref);
      if (id === undefined) throw new Error(`check_scope: no item for ${ref}`);
      return id;
    },
    evidenceSetHash: canonicalHash(
      items.map((item, i) => {
        const id = ids[i] ?? "";
        return { id, sha256: item.sha256, facts: factsIdOf.get(id) ?? null };
      }),
    ),
  };
}

async function recordUnavailable(
  db: Db,
  tx: Tx,
  ws: WorkspaceId,
  detail: { packId: string; runId: string | null; status: string; reason: string },
): Promise<void> {
  await forWorkspace(db, ws).auditLog.insert(
    {
      actor: "agent",
      action: "check_unavailable",
      detail: { ...detail, reason: detail.reason.slice(0, 500), promptVersion: CHECK_SCOPE_PROMPT.id },
    },
    tx,
  );
}
