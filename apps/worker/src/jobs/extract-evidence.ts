// `evidence.added` consumer (M2-03): run `extract@v1` on the new item through the M2-02 harness, then write
// `extracted_facts` and emit `pack.extracted` (M2-04's scope check) in the consumer's transaction.
// - idempotent on (evidence_item_id, prompt version): a row already there means nothing runs and nothing is
//   written; the unique key backs the pre-check if two deliveries race. The consumer receipt covers an exact
//   re-delivery; the harness's content-hash cache covers identical canned evidence in another item.
// - a run without output (degraded, budget, limits, kill switch, invalid output) writes no facts row; the
//   run's status and error are in `agent_runs`, and an `audit_log` entry `extract.no_facts` names the item.
//   The pack's state is never touched here, so it stays `collecting`. The job is acked, not retried: a
//   re-run is a seller action (M2-05), so a down provider never loops on the queue.
import { createPostgresBlobStore } from "@cleared/adapters/files";
import {
  EvidenceAddedEvent,
  EXTRACT_PROMPT,
  extractInputFor,
  extractWorkflow,
  runWorkflow,
  withEvidenceIds,
  type AgentConfig,
  type AiProvider,
  type ExtractInput,
  type Instant,
  type WorkspaceId,
} from "@cleared/core";
import {
  createRunStore,
  evidenceRepo,
  extractedFactsRepo,
  forWorkspace,
  type Db,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface ExtractEvidenceDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly provider: AiProvider;
  readonly config: AgentConfig;
  readonly now: () => Date;
}

export type ExtractOutcome =
  | { readonly status: "written"; readonly factsId: string; readonly runId: string }
  | { readonly status: "exists" }
  | { readonly status: "not_found" }
  | { readonly status: "no_content" }
  | { readonly status: "no_facts"; readonly runStatus: string; readonly runId: string | null };

type AddedEvent = ReturnType<typeof EvidenceAddedEvent.parse>;

export function extractEvidenceHandler(deps: ExtractEvidenceDeps): Handler {
  return async (data, ctx) => {
    await extractEvidence(deps, EvidenceAddedEvent.parse(data), ctx);
  };
}

export async function extractEvidence(
  deps: ExtractEvidenceDeps,
  event: AddedEvent,
  ctx: Pick<ConsumeContext, "tx" | "log" | "envelope">,
): Promise<ExtractOutcome> {
  const ws = event.workspaceId;
  const { evidenceItemId, packId } = event.data;
  const facts = extractedFactsRepo(deps.db, ws);
  if (await facts.forItem(evidenceItemId, EXTRACT_PROMPT.id, ctx.tx)) return { status: "exists" };
  const input = await inputFor(deps.db, ws, evidenceItemId, ctx.tx);
  if (input === "not_found" || input === null) {
    const status = input === null ? "no_content" : "not_found";
    ctx.log.warn({ evidenceItemId, status }, "extract skipped");
    return { status };
  }
  const out = await runWorkflow(extractWorkflow, input, {
    provider: deps.provider,
    store: createRunStore(deps.db),
    config: deps.config,
    workspaceId: ws,
    correlationId: ctx.envelope.correlationId,
  });
  if ("reason" in out) {
    await recordNoFacts(deps.db, ctx.tx, ws, {
      evidenceItemId,
      runId: out.runId,
      status: out.status,
      reason: out.reason,
    });
    ctx.log.warn(
      { evidenceItemId, runId: out.runId, runStatus: out.status, reason: out.reason },
      "extract: no facts",
    );
    return { status: "no_facts", runStatus: out.status, runId: out.runId };
  }
  const stored = withEvidenceIds(out.output, () => evidenceItemId);
  const row = await facts.insert(
    {
      evidenceItemId,
      facts: stored,
      model: deps.config.models.small,
      runId: out.runId,
      promptVersion: EXTRACT_PROMPT.id,
    },
    ctx.tx,
  );
  if (row === null) return { status: "exists" }; // a concurrent delivery wrote it first
  await deps.publisher.emit(ctx.tx, {
    type: "pack.extracted",
    version: 1,
    workspaceId: event.workspaceId,
    occurredAt: deps.now().toISOString() as Instant,
    data: { packId, evidenceItemId, factsId: row.id, runId: out.runId },
  });
  ctx.log.info(
    { evidenceItemId, factsId: row.id, runId: out.runId, runStatus: out.status },
    "extract: facts written",
  );
  return { status: "written", factsId: row.id, runId: out.runId };
}

/** The item's text, or its file's bytes (base64) as an image / PDF part. */
async function inputFor(
  db: Db,
  ws: WorkspaceId,
  itemId: string,
  tx: Tx,
): Promise<ExtractInput | null | "not_found"> {
  const item = await evidenceRepo(db, ws).items.get(itemId, tx);
  if (!item) return "not_found";
  const blob = item.blobId ? await createPostgresBlobStore(db).get(ws, item.blobId, tx) : null;
  return extractInputFor({
    kind: item.kind,
    sha256: item.sha256,
    text: item.text,
    file: blob ? { mime: blob.mime, base64: Buffer.from(blob.bytes).toString("base64") } : null,
  });
}

async function recordNoFacts(
  db: Db,
  tx: Tx,
  ws: WorkspaceId,
  detail: { evidenceItemId: string; runId: string | null; status: string; reason: string },
): Promise<void> {
  await forWorkspace(db, ws).auditLog.insert(
    {
      actor: "agent",
      action: "extract.no_facts",
      detail: { ...detail, reason: detail.reason.slice(0, 500), promptVersion: EXTRACT_PROMPT.id },
    },
    tx,
  );
}
