// M2-09 test seed (integration tests and the local E2E specs): a workspace's disputed payment (PENDING /
// BUYER_COMPLAINT, $120.00 USD), its proof pack, the dispute mirror (WAITING_FOR_SELLER_RESPONSE,
// links accept_claim + provide_evidence) and the draft M2-07 writes: the notes are the recorded
// `draft_dispute@v1` answer (fixtures/openai/draft-v1/logo.json, no model call), the PDF is compiled by the
// real `compileEvidencePdf`, and the proposal goes through the real guardrail (`checkProposal`) and
// `insertProposedAction`, in one transaction, as the drafting job does. Personal data is synthetic.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileEvidencePdf, createPostgresBlobStore } from "@cleared/adapters/files";
import { canonicalHash, checkProposal, WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import {
  disputeDraftsRepo,
  evidenceRepo,
  forWorkspace,
  insertProposedAction,
  platform,
  scopeChecksRepo,
  withTransaction,
  type Db,
} from "@cleared/db";

const FIXTURE = new URL("../../../../fixtures/openai/draft-v1/logo.json", import.meta.url);

/** The recorded draft's notes (M2-07 live run). */
export function recordedNotes(): string {
  const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    response: { body: { output: { content?: { text?: string }[] }[] } };
  };
  for (const o of f.response.body.output)
    for (const c of o.content ?? [])
      if (c.text !== undefined) return (JSON.parse(c.text) as { notes: string }).notes;
  throw new Error("no draft output in the fixture");
}

/** E2E ids the local PayPal stub recognises (`PP-D-E2E-…`); the capture id is derived from it. */
export function e2eDisputeIds(prefix = ""): { disputeId: string; captureId: string } {
  const hex = (prefix + randomBytes(5).toString("hex").toUpperCase()).slice(0, 10);
  return { disputeId: `PP-D-E2E-${hex}`, captureId: captureIdFor(`PP-D-E2E-${hex}`) };
}
export const captureIdFor = (disputeId: string): string => `E2E${disputeId.slice(-10)}CAP0`;

const ITEMS = [
  {
    kind: "scope",
    text: "Scope agreed with Asha Rao on 2 Oct: primary logo in SVG and PNG, black and white variants, a one-page PDF brand guide. Final files due 20 October.",
  },
  {
    kind: "delivery",
    text: "Delivered 18 Oct: logo-primary.svg, logo-primary.png, logo-bw.png, brand-guide.pdf (uploaded to the shared folder).",
  },
  {
    kind: "communication",
    text: "15 Oct, client: We approve direction B. 19 Oct, client: Thanks, these look great.",
  },
] as const;

export interface SeededDispute {
  readonly disputeRowId: string;
  readonly paypalDisputeId: string;
  readonly captureId: string;
  readonly paymentId: string;
  readonly draftId: string;
  readonly actionId: string;
  readonly payloadSha256: string;
  readonly itemIds: readonly string[];
}

export interface SeedOptions {
  readonly ids?: { disputeId: string; captureId: string };
  readonly dueDate?: Date;
  readonly allowed?: readonly string[];
  readonly draft?: boolean;
}

async function seedMirror(db: Db, ws: string, o: SeedOptions) {
  const r = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const ids = o.ids ?? e2eDisputeIds();
  const owners = platform(db).resourceOwners;
  await owners.claim({ resourceType: "capture", resourceId: ids.captureId, workspaceId: ws });
  await owners.claim({ resourceType: "dispute", resourceId: ids.disputeId, workspaceId: ws });
  const payment = await r.payments.insert({
    captureId: ids.captureId,
    amount: "120.00",
    currency: "USD",
    status: "PENDING",
    statusReason: "BUYER_COMPLAINT",
    source: "webhook",
    paypalUpdatedAt: new Date("2026-10-20T05:00:00.000Z"),
  });
  const dispute = await r.disputes.insert({
    disputeId: ids.disputeId,
    paymentId: payment.id,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    stage: "INQUIRY",
    status: "WAITING_FOR_SELLER_RESPONSE",
    sellerResponseDueDate: o.dueDate ?? new Date(Date.now() + 5 * 86_400_000),
    amount: "120.00",
    currency: "USD",
    allowedActions: [...(o.allowed ?? ["accept_claim", "provide_evidence"])],
    paypalUpdatedAt: new Date("2026-10-20T05:00:00.000Z"),
  });
  return { r, ids, payment, dispute };
}

export async function seedDispute(db: Db, ws: string, o: SeedOptions = {}): Promise<SeededDispute> {
  const { r, ids, payment, dispute } = await seedMirror(db, ws, o);
  return withTransaction(db, async (tx) => {
    const pack = await r.proofPacks.insert({ paymentId: payment.id, state: "checked" }, tx);
    for (const i of ITEMS) {
      const sha256 = createHash("sha256").update(i.text).digest("hex");
      await r.evidenceItems.insert({ packId: pack.id, kind: i.kind, text: i.text, sha256 }, tx);
    }
    // the app's order (oldest first, as E1, E2…): the read the screens and the revise route use
    const ev = evidenceRepo(db, WorkspaceIdSchema.parse(ws));
    const items = (await ev.items.listForPack(pack.id, tx)).reverse();
    const base = {
      disputeRowId: dispute.id,
      paypalDisputeId: ids.disputeId,
      captureId: ids.captureId,
      paymentId: payment.id,
    };
    if (o.draft === false)
      return { ...base, draftId: "", actionId: "", payloadSha256: "", itemIds: items.map((i) => i.id) };
    const pdf = await compileEvidencePdf(
      {
        disputeId: ids.disputeId,
        captureId: ids.captureId,
        amount: { value: "120.00", currency_code: "USD" },
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        evidenceType: "OTHER",
        compiledAt: new Date().toISOString(),
      },
      items.map((i, n) => ({
        id: i.id,
        ref: `E${String(n + 1)}`,
        kind: i.kind,
        sha256: i.sha256,
        addedAt: i.createdAt.toISOString(),
        mime: null,
        bytes: null,
        text: i.text,
      })),
    );
    if (!pdf.ok) throw new Error(`seed compile failed: ${pdf.error.code}`);
    const blob = await createPostgresBlobStore(db).put(
      { workspaceId: WorkspaceIdSchema.parse(ws), bytes: pdf.value.bytes, mime: "application/pdf" },
      tx,
    );
    const run = await r.agentRuns.insert(
      { task: "draft_dispute", inputHash: "d".repeat(64), model: "recorded-fixture", status: "succeeded" },
      tx,
    );
    const draftId = randomUUID();
    const notes = recordedNotes();
    const payload: JsonValue = {
      dispute_id: ids.disputeId,
      notes,
      compiled_blob_sha256: pdf.value.sha256,
      draft_id: draftId,
      evidence_type: "OTHER",
    };
    const checked = checkProposal("provide_evidence", payload);
    if (!checked.ok) throw new Error(`seed proposal refused: ${checked.detail}`);
    const actionId = await insertProposedAction(
      db,
      { workspaceId: WorkspaceIdSchema.parse(ws), runId: run.id, proposal: checked.proposal, at: new Date() },
      tx,
    );
    await disputeDraftsRepo(db, WorkspaceIdSchema.parse(ws)).insert(
      {
        id: draftId,
        disputeId: dispute.id,
        packId: pack.id,
        checkVersion: 1,
        actionKind: "provide_evidence",
        evidenceType: "OTHER",
        reasonUnmapped: false,
        notes,
        evidenceItemIds: items.map((i) => i.id),
        factRefs: [],
        compiledBlobId: blob.id,
        sha256: canonicalHash(payload),
        runId: run.id,
        proposedActionId: actionId,
      },
      tx,
    );
    return {
      ...base,
      draftId,
      actionId,
      payloadSha256: canonicalHash(payload),
      itemIds: items.map((i) => i.id),
    };
  });
}

/**
 * BL-01 6539398891: the seeded draft's scope check (version 1, the one the draft read) as M2-04 writes it,
 * with C7 `missing`, and the draft's fact_refs pointing a paragraph at C1 and C7, as the recorded M2-07
 * answer does (fixtures/openai/draft-v1/logo.json paragraph 5). The notes are left as they are.
 */
export async function seedScopeGap(db: Db, ws: string, s: SeededDispute): Promise<void> {
  const wsId = WorkspaceIdSchema.parse(ws);
  const line = (lineId: string, text: string, verdict: "met" | "missing") => ({
    lineId,
    line: text,
    verdict,
    modelVerdict: verdict,
    note: null,
    rationale: "seeded",
    lineCitation: null,
    citations: [],
  });
  await withTransaction(db, async (tx) => {
    const draft = (await disputeDraftsRepo(db, wsId).listForDispute(s.disputeRowId, tx))[0];
    if (draft?.packId == null) throw new Error("seedScopeGap: no seeded draft");
    const check = await scopeChecksRepo(db, wsId).insertCheck(
      {
        packId: draft.packId,
        evidenceSetHash: "e".repeat(64),
        promptVersion: "check_scope@v1",
        runId: null,
        lines: [
          line("C1", "Provide the primary logo in SVG format.", "met"),
          line("C7", "Provide the editable Adobe Illustrator (.ai) source file.", "missing"),
        ],
      },
      tx,
    );
    if (check?.checkVersion !== draft.checkVersion) throw new Error("seedScopeGap: check version mismatch");
  });
  const factRefs = [
    { paragraph: 2, refs: [{ ref: "C1", kind: "line", evidence_item_id: null }] },
    { paragraph: 5, refs: [{ ref: "C7", kind: "line", evidence_item_id: null }] },
  ];
  await db.$client.query("update dispute_drafts set fact_refs = $1::jsonb where id = $2", [
    JSON.stringify(factRefs),
    s.draftId,
  ]);
}
