// Dispute drafting (M2-07): when a dispute offers an evidence action and its payment's pack is checked, run
// `draft_dispute@v1` through the M2-02 harness, compile the selected items into one PDF and, in the consumer's
// transaction, write the compiled blob, the `dispute_drafts` row and the proposal (kind from the dispute's
// current links). The seller approves or rejects it (M2-08/M2-09); nothing is ever filed from here.
// - triggers: `dispute.opened`, `dispute.status_changed` (that dispute) and `pack.checked` (the open disputes
//   on the pack's payment).
// - the dispute is re-fetched (a read) for its current links, reason, amount, due date and the evidence types
//   PayPal requests; the mirror's `deadline_state` and the fresh due date both gate `closed_for_action`.
// - idempotent per (dispute, pack scope check version, filing action): a re-delivery finds the draft.
// - a run without a valid answer, or a selection whose PDF is ≥ 10 MB, writes no draft and no proposal: an
//   `audit_log` entry `dispute_draft.unavailable` records why (`notes_too_long`, `pdf_too_large` with item sizes…).
import { randomUUID } from "node:crypto";
import { allowedActions, type Dispute, type PayPalDisputesClient } from "@cleared/adapters";
import {
  compileEvidencePdf,
  createPostgresBlobStore,
  type CompileError,
  type CompileItem,
} from "@cleared/adapters/files";
import {
  buildDraftInput,
  canonicalHash,
  checkProposal,
  deadlineState,
  DisputeOpenedEvent,
  DisputeStatusChangedEvent,
  draftDisputeWorkflow,
  draftProblemOf,
  EXTRACT_PROMPT,
  filingKindFor,
  fromEpochMs,
  InstantSchema,
  mapReason,
  PackCheckedEvent,
  requestedEvidenceTypes,
  runWorkflow,
  type AgentConfig,
  type AiProvider,
  type DraftInput,
  type DraftOutput,
  type DraftRefs,
  type FilingKind,
  type JsonValue,
  type ReasonMapping,
  type WorkspaceId,
} from "@cleared/core";
import {
  createRunStore,
  disputeDraftsRepo,
  DRAFT_AUDIT_ACTIONS,
  evidenceRepo,
  extractedFactsRepo,
  forWorkspace,
  insertProposedAction,
  scopeChecksRepo,
  type Db,
  type DisputeRow,
  type ScopeCheckRow,
  type StoredFactRef,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface DraftDisputeDeps {
  readonly db: Db;
  readonly provider: AiProvider;
  readonly config: AgentConfig;
  readonly disputes: Pick<PayPalDisputesClient, "getDispute">;
  readonly now: () => Date;
}

export const DRAFT_SKIPS = [
  "dispute_not_found",
  "resolved",
  "no_pack",
  "pack_not_checked",
  "no_scope_check",
  "no_evidence_action",
] as const;
export type DraftSkip = (typeof DRAFT_SKIPS)[number];

export type DraftDisputeOutcome =
  | {
      readonly status: "written";
      readonly draftId: string;
      readonly actionId: string;
      readonly runId: string;
      readonly kind: FilingKind;
      readonly evidenceType: string;
      readonly payloadSha256: string;
      readonly compiledSha256: string;
    }
  | { readonly status: "exists"; readonly draftId: string }
  | { readonly status: "too_late" }
  | { readonly status: "skipped"; readonly reason: DraftSkip }
  | {
      readonly status: "unavailable";
      readonly code: string;
      readonly runStatus: string;
      readonly runId: string | null;
    };

type Ctx = Pick<ConsumeContext, "tx" | "log" | "envelope">;

export function draftDisputeHandler(deps: DraftDisputeDeps): Handler {
  return async (data, ctx) => {
    await draftForTrigger(deps, data, ctx);
  };
}

/** Resolves the trigger to its dispute(s) and drafts each. */
export async function draftForTrigger(
  deps: DraftDisputeDeps,
  data: unknown,
  ctx: Ctx,
): Promise<DraftDisputeOutcome[]> {
  const type = (data as { type?: unknown } | null)?.type;
  if (type === "pack.checked") {
    const e = PackCheckedEvent.parse(data);
    const pack = await forWorkspace(deps.db, e.workspaceId).proofPacks.get(e.data.packId, ctx.tx);
    if (!pack) return [{ status: "skipped", reason: "no_pack" }];
    const open = await disputeDraftsRepo(deps.db, e.workspaceId).openDisputesForPayment(
      pack.paymentId,
      ctx.tx,
    );
    const out: DraftDisputeOutcome[] = [];
    for (const d of open) out.push(await draftDispute(deps, e.workspaceId, d, ctx));
    return out;
  }
  const e =
    type === "dispute.opened" ? DisputeOpenedEvent.parse(data) : DisputeStatusChangedEvent.parse(data);
  const row = await forWorkspace(deps.db, e.workspaceId).disputes.getByDisputeId(e.data.disputeId, ctx.tx);
  if (!row) return [{ status: "skipped", reason: "dispute_not_found" }];
  return [await draftDispute(deps, e.workspaceId, row, ctx)];
}

interface Target {
  readonly ws: WorkspaceId;
  readonly row: DisputeRow;
  readonly packId: string;
  readonly lines: readonly ScopeCheckRow[];
  readonly checkVersion: number;
  readonly fresh: Dispute;
  readonly kind: FilingKind;
}

/** The checks before any model call: pack checked, an evidence action offered, not drafted, not too late. */
async function resolveTarget(
  deps: DraftDisputeDeps,
  ws: WorkspaceId,
  row: DisputeRow,
  tx: Tx,
): Promise<Target | DraftDisputeOutcome> {
  const skip = (reason: DraftSkip): DraftDisputeOutcome => ({ status: "skipped", reason });
  if (row.status === "RESOLVED") return skip("resolved");
  if (row.paymentId === null) return skip("no_pack");
  const pack = await forWorkspace(deps.db, ws).proofPacks.getByPaymentId(row.paymentId, tx);
  if (!pack) return skip("no_pack");
  if (pack.state !== "checked" && pack.state !== "ready") return skip("pack_not_checked");
  const lines = await scopeChecksRepo(deps.db, ws).latestForPack(pack.id, tx);
  const checkVersion = lines[0]?.checkVersion;
  if (checkVersion === undefined) return skip("no_scope_check");
  const fresh = await deps.disputes.getDispute(row.disputeId);
  const kind = filingKindFor(allowedActions(fresh));
  if (kind === null) return skip("no_evidence_action");
  const drafts = disputeDraftsRepo(deps.db, ws);
  const existing = await drafts.findForKey(row.id, checkVersion, kind, tx);
  if (existing) return { status: "exists", draftId: existing.id };
  const target: Target = { ws, row, packId: pack.id, lines, checkVersion, fresh, kind };
  if (isTooLate(row, fresh, deps.now())) return recordTooLate(deps, target, tx);
  return target;
}

function isTooLate(row: DisputeRow, fresh: Dispute, now: Date): boolean {
  if (row.deadlineState === "closed_for_action") return true;
  const due = fresh.seller_response_due_date;
  if (due === undefined) return false;
  const dueAt = InstantSchema.parse(new Date(due).toISOString());
  return deadlineState(dueAt, fromEpochMs(now.getTime())) === "closed_for_action";
}

async function recordTooLate(deps: DraftDisputeDeps, t: Target, tx: Tx): Promise<DraftDisputeOutcome> {
  const key = { disputeId: t.row.id, checkVersion: t.checkVersion, actionKind: t.kind };
  const drafts = disputeDraftsRepo(deps.db, t.ws);
  if (!(await drafts.outcomeRecorded(DRAFT_AUDIT_ACTIONS.tooLate, key, tx))) {
    await forWorkspace(deps.db, t.ws).auditLog.insert(
      {
        actor: "system",
        action: DRAFT_AUDIT_ACTIONS.tooLate,
        detail: {
          ...key,
          paypalDisputeId: t.row.disputeId,
          dueDate: t.fresh.seller_response_due_date ?? null,
        },
      },
      tx,
    );
  }
  return { status: "too_late" };
}

export async function draftDispute(
  deps: DraftDisputeDeps,
  ws: WorkspaceId,
  row: DisputeRow,
  ctx: Ctx,
): Promise<DraftDisputeOutcome> {
  const target = await resolveTarget(deps, ws, row, ctx.tx);
  if ("status" in target) {
    ctx.log.info({ disputeId: row.disputeId, outcome: target.status }, "dispute draft not run");
    return target;
  }
  const mapping = mapReason(target.fresh.reason, requestedEvidenceTypes(target.fresh.evidences));
  const { input, refs, items } = await loadSource(deps, target, mapping, ctx.tx);
  const out = await runWorkflow(draftDisputeWorkflow, input, {
    provider: deps.provider,
    store: createRunStore(deps.db),
    config: deps.config,
    workspaceId: ws,
    correlationId: ctx.envelope.correlationId,
  });
  if ("reason" in out) {
    const code = draftProblemOf(out.reason) ?? out.status;
    await recordUnavailable(deps, target, ctx.tx, {
      runId: out.runId,
      status: out.status,
      code,
      reason: out.reason,
    });
    ctx.log.warn(
      { disputeId: row.disputeId, runId: out.runId, runStatus: out.status, code },
      "dispute draft unavailable",
    );
    return { status: "unavailable", code, runStatus: out.status, runId: out.runId };
  }
  const compiled = await compileSelection(deps, target, input, out.output, refs, items, ctx.tx);
  if (!compiled.ok) {
    const e = compiled.error;
    await recordUnavailable(deps, target, ctx.tx, {
      runId: out.runId,
      status: "succeeded",
      code: e.code,
      error: e,
    });
    return { status: "unavailable", code: e.code, runStatus: out.status, runId: out.runId };
  }
  return persist(deps, target, ctx, {
    input,
    output: out.output,
    refs,
    runId: out.runId,
    compiled: compiled.value,
  });
}

type PackItem = Awaited<ReturnType<ReturnType<typeof evidenceRepo>["items"]["listForPack"]>>[number];

/** The pack (oldest item first, as `E1..`), its facts and the latest check, as the draft's input. */
async function loadSource(deps: DraftDisputeDeps, t: Target, mapping: ReasonMapping, tx: Tx) {
  const items = (await evidenceRepo(deps.db, t.ws).items.listForPack(t.packId, tx)).reverse();
  const facts = await extractedFactsRepo(deps.db, t.ws).listForPack(t.packId, EXTRACT_PROMPT.id, tx);
  const amount = t.fresh.dispute_amount;
  const built = buildDraftInput({
    dispute: {
      dispute_id: t.fresh.dispute_id,
      capture_id: t.fresh.disputed_transactions?.[0]?.seller_transaction_id ?? null,
      reason: t.fresh.reason,
      amount: amount ? { value: amount.value, currency_code: amount.currency_code } : null,
      opened_at: t.fresh.create_time,
      seller_response_due_date: t.fresh.seller_response_due_date ?? null,
    },
    mapping,
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      createdAt: i.createdAt.toISOString(),
      mime: i.mime,
      text: i.text,
    })),
    facts: facts.map((f) => ({ evidenceItemId: f.evidenceItemId, facts: f.facts })),
    lines: t.lines.map((l) => ({
      lineId: l.lineId,
      line: l.line,
      verdict: l.verdict,
      lineCitation: l.lineCitation,
      citations: l.citations,
    })),
  });
  return { ...built, items };
}

interface Compiled {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly itemIds: readonly string[];
}

/** The model's selection (deduplicated, in its order) compiled into one PDF. */
async function compileSelection(
  deps: DraftDisputeDeps,
  t: Target,
  input: DraftInput,
  output: DraftOutput,
  refs: DraftRefs,
  items: readonly PackItem[],
  tx: Tx,
): Promise<{ ok: true; value: Compiled } | { ok: false; error: CompileError }> {
  const blobs = createPostgresBlobStore(deps.db);
  const selected: CompileItem[] = [];
  for (const ref of [...new Set(output.selected_evidence_item_ids)]) {
    const item = items.find((i) => i.id === refs.itemIdOf.get(ref));
    if (!item) continue; // the validator guarantees every ref is a pack item
    const blob = item.blobId === null ? null : await blobs.get(t.ws, item.blobId, tx);
    selected.push({
      id: item.id,
      ref,
      kind: item.kind,
      sha256: item.sha256,
      addedAt: item.createdAt.toISOString(),
      mime: blob?.mime ?? null,
      bytes: blob ? new Uint8Array(blob.bytes) : null,
      text: item.text,
    });
  }
  const r = await compileEvidencePdf(
    {
      disputeId: input.dispute.dispute_id,
      captureId: input.dispute.capture_id,
      amount: input.dispute.amount,
      reason: input.dispute.reason,
      evidenceType: input.dispute.evidence_type,
      compiledAt: deps.now().toISOString(),
    },
    selected,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: { bytes: r.value.bytes, sha256: r.value.sha256, itemIds: selected.map((s) => s.id) },
  };
}

/** The filing payload M2-08 executes (core `actions/policy.ts`). */
export function filingPayload(
  kind: FilingKind,
  p: { disputeId: string; evidenceType: string; notes: string; compiledSha256: string; draftId: string },
): JsonValue {
  const common = {
    dispute_id: p.disputeId,
    notes: p.notes,
    compiled_blob_sha256: p.compiledSha256,
    draft_id: p.draftId,
  };
  return kind === "provide_evidence" ? { ...common, evidence_type: p.evidenceType } : common;
}

function storedFactRefs(input: DraftInput, output: DraftOutput, refs: DraftRefs) {
  const itemOf = (evidenceRef: string): string | null => refs.itemIdOf.get(evidenceRef) ?? null;
  const resolve = (ref: string): StoredFactRef => {
    const fact = input.facts.find((f) => f.ref === ref);
    if (fact) return { ref, kind: "fact", evidence_item_id: itemOf(fact.evidence_ref) };
    const quote = input.quotes.find((q) => q.ref === ref);
    if (quote) return { ref, kind: "quote", evidence_item_id: itemOf(quote.evidence_ref) };
    if (ref.startsWith("E")) return { ref, kind: "item", evidence_item_id: itemOf(ref) };
    return { ref, kind: "line", evidence_item_id: null };
  };
  return output.fact_refs.map((f) => ({ paragraph: f.paragraph, refs: f.refs.map(resolve) }));
}

interface Drafted {
  readonly input: DraftInput;
  readonly output: DraftOutput;
  readonly refs: DraftRefs;
  readonly runId: string;
  readonly compiled: Compiled;
}

/** One transaction (the consumer's): compiled blob, proposal (+ outbox, audit), draft row. */
async function persist(
  deps: DraftDisputeDeps,
  t: Target,
  ctx: Ctx,
  d: Drafted,
): Promise<DraftDisputeOutcome> {
  const drafts = disputeDraftsRepo(deps.db, t.ws);
  await drafts.lockDispute(t.row.id, ctx.tx); // drafting is serial per dispute
  const existing = await drafts.findForKey(t.row.id, t.checkVersion, t.kind, ctx.tx);
  if (existing) return { status: "exists", draftId: existing.id }; // a concurrent delivery wrote it first
  await evidenceRepo(deps.db, t.ws).lockWorkspace(ctx.tx); // M2-01: the workspace lock before any blob lock
  const blob = await createPostgresBlobStore(deps.db).put(
    { workspaceId: t.ws, bytes: d.compiled.bytes, mime: "application/pdf" },
    ctx.tx,
  );
  const draftId = randomUUID();
  const evidenceType = d.input.dispute.evidence_type;
  const payload = filingPayload(t.kind, {
    disputeId: t.row.disputeId,
    evidenceType,
    notes: d.output.notes,
    compiledSha256: d.compiled.sha256,
    draftId,
  });
  const checked = checkProposal(t.kind, payload);
  if (!checked.ok) throw new Error(`draft proposal refused by the guardrail: ${checked.detail}`);
  const at = deps.now();
  const actionId = await insertProposedAction(
    deps.db,
    { workspaceId: t.ws, runId: d.runId, proposal: checked.proposal, at },
    ctx.tx,
  );
  await drafts.insert(
    {
      id: draftId,
      disputeId: t.row.id,
      packId: t.packId,
      checkVersion: t.checkVersion,
      actionKind: t.kind,
      evidenceType,
      reasonUnmapped: d.input.dispute.reason_unmapped,
      notes: d.output.notes,
      evidenceItemIds: d.compiled.itemIds,
      factRefs: storedFactRefs(d.input, d.output, d.refs),
      compiledBlobId: blob.id,
      sha256: canonicalHash(payload),
      runId: d.runId,
      proposedActionId: actionId,
    },
    ctx.tx,
  );
  ctx.log.info({ disputeId: t.row.disputeId, draftId, actionId, kind: t.kind }, "dispute draft written");
  return {
    status: "written",
    draftId,
    actionId,
    runId: d.runId,
    kind: t.kind,
    evidenceType,
    payloadSha256: checked.proposal.payloadSha256,
    compiledSha256: d.compiled.sha256,
  };
}

async function recordUnavailable(
  deps: DraftDisputeDeps,
  t: Target,
  tx: Tx,
  detail: { runId: string | null; status: string; code: string; reason?: string; error?: CompileError },
): Promise<void> {
  await forWorkspace(deps.db, t.ws).auditLog.insert(
    {
      actor: "agent",
      action: DRAFT_AUDIT_ACTIONS.unavailable,
      detail: {
        disputeId: t.row.id,
        paypalDisputeId: t.row.disputeId,
        checkVersion: t.checkVersion,
        actionKind: t.kind,
        runId: detail.runId,
        status: detail.status,
        code: detail.code,
        reason: detail.reason?.slice(0, 500) ?? null,
        ...(detail.error === undefined ? {} : { error: detail.error as unknown as JsonValue }),
        promptVersion: draftDisputeWorkflow.prompt.id,
      },
    },
    tx,
  );
}
