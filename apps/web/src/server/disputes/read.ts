// M2-09: the dispute list and detail read models (workspace-scoped). PayPal's fields are passed through
// verbatim; the draft shown is the current one per BL-01 6538667356: the newest draft whose filing was
// acted on, or the newest still `proposed` whose action PayPal currently allows. A superseded proposal
// (an older draft whose action the links no longer offer) is never shown or approvable from here.
import { AgentEnvSchema, type Amount, type WorkspaceId } from "@cleared/core";
import {
  auditPage,
  blobMeta,
  disputeDraftsRepo,
  disputeList,
  draftsWithActions,
  evidenceRepo,
  forWorkspace,
  getProposedAction,
  latestAcceptClaim,
  latestDraftOutcome,
  platform,
  scenarioForDispute,
  type AutoEvidence,
  type DisputeListRow,
  type DraftWithAction,
} from "@cleared/db";
import { z } from "zod";
import type {
  DisputeDetail,
  DisputeList,
  DisputeSummary,
  Draft,
  DraftItem,
  DraftItemAuto,
} from "../../lib/dispute-view.ts";
import { auditEntry } from "../audit-entry.ts";
import type { Deps } from "../deps.ts";
import { view } from "../handlers/actions.ts";

const Links = z.array(z.string()).catch([]);
const OutcomeJson = z
  .object({ outcome_code: z.string(), outcome_reason: z.string().nullish() })
  .nullable()
  .catch(null);
const ACTED = new Set(["approved", "executing", "unknown", "succeeded", "failed"]);

/** BL-01 6538667356: which of a dispute's drafts (newest first) the seller sees. */
export function currentDraft(rows: readonly DraftWithAction[], allowed: readonly string[]) {
  for (const r of rows) {
    if (r.actionState !== null && ACTED.has(r.actionState)) return r;
    const kind = r.draft.actionKind;
    if (r.actionState === "proposed" && kind !== null && allowed.includes(kind)) return r;
  }
  return rows[0] ?? null;
}

function summary(r: DisputeListRow, drafts: readonly DraftWithAction[]): DisputeSummary {
  const d = r.dispute;
  const allowed = Links.parse(d.allowedActions);
  const cur = currentDraft(drafts, allowed);
  const outcome = OutcomeJson.parse(d.outcome);
  return {
    id: d.id,
    disputeId: d.disputeId,
    status: d.status,
    stage: d.stage,
    reason: d.reason,
    amount:
      d.amount !== null && d.currency !== null ? { value: d.amount, currency: d.currency.trim() } : null,
    dueDate: d.sellerResponseDueDate?.toISOString() ?? null,
    deadlineState: d.deadlineState,
    outcome: outcome === null ? null : { ...outcome, outcome_reason: outcome.outcome_reason ?? null },
    payment:
      r.payment === null
        ? null
        : {
            id: r.payment.id,
            captureId: r.payment.captureId,
            amount: { value: r.payment.amount, currency: r.payment.currency },
            status: r.payment.status,
            statusReason: r.payment.statusReason,
          },
    draftReady:
      cur !== null &&
      cur.actionState === "proposed" &&
      cur.draft.actionKind !== null &&
      allowed.includes(cur.draft.actionKind) &&
      d.deadlineState !== "closed_for_action",
  };
}

/** Open disputes' amounts per currency (exact decimal sums in cents; never across currencies). */
function inDispute(items: readonly DisputeSummary[]): Amount[] {
  const cents = new Map<string, bigint>();
  for (const i of items) {
    if (i.status === "RESOLVED" || i.amount === null) continue;
    const [whole = "0", frac = ""] = i.amount.value.split(".");
    const c = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
    cents.set(i.amount.currency, (cents.get(i.amount.currency) ?? 0n) + c);
  }
  return [...cents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, c]) => ({
      currency,
      value: `${String(c / 100n)}.${String(c % 100n).padStart(2, "0")}`,
    }));
}

async function draftsByDispute(deps: Deps, ws: string, ids: readonly string[]) {
  const by = new Map<string, DraftWithAction[]>();
  for (const r of await draftsWithActions(deps.db, ws, ids)) {
    const list = by.get(r.draft.disputeId) ?? [];
    list.push(r);
    by.set(r.draft.disputeId, list);
  }
  return by;
}

export async function listDisputes(deps: Deps, ws: string): Promise<DisputeList> {
  const rows = await disputeList(deps.db, ws);
  const drafts = await draftsByDispute(
    deps,
    ws,
    rows.map((r) => r.dispute.id),
  );
  const items = rows.map((r) => summary(r, drafts.get(r.dispute.id) ?? []));
  const w = await platform(deps.db).workspaces.get(ws);
  return { items, summary: { inDispute: inDispute(items) }, workspace: { timezone: w?.timezone ?? "UTC" } };
}

type ItemSource = Pick<DraftWithAction["draft"], "packId" | "evidenceItemIds">;

/** BL-01 6595501766: an item code added (still selected) or left out (still unselected) of the agent's draft. */
function autoOf(id: string, selected: boolean, auto: AutoEvidence | null): DraftItemAuto | null {
  if (auto === null) return null;
  if (selected && auto.added.some((a) => a.id === id)) return { state: "added", code: null, bytes: null };
  const out = auto.leftOut.find((l) => l.id === id);
  return !selected && out ? { state: "left_out", code: out.code, bytes: out.bytes } : null;
}

/** The pack's items (oldest first, E1…), ticked when selected, each linked to its file and its pack entry. */
async function draftItems(
  deps: Deps,
  ws: string,
  d: ItemSource,
  paymentId: string | null,
  auto: AutoEvidence | null = null,
): Promise<DraftItem[]> {
  const ev = evidenceRepo(deps.db, ws as WorkspaceId);
  const items =
    d.packId === null
      ? (await Promise.all(d.evidenceItemIds.map((id) => ev.items.get(id)))).flatMap((i) =>
          i === null ? [] : [{ ...i, mime: null as string | null, size: null as number | null }],
        )
      : (await ev.items.listForPack(d.packId)).reverse(); // oldest first: E1, E2… as the PDF labels them
  const selected = new Set(d.evidenceItemIds);
  return items.map((i, n) => ({
    id: i.id,
    ref: `E${String(n + 1)}`,
    kind: i.kind,
    mime: i.mime,
    size: i.size,
    addedAt: i.createdAt.toISOString(),
    selected: selected.has(i.id),
    fileUrl: i.blobId === null ? null : `/api/evidence/${i.id}/file`,
    packUrl: paymentId === null ? null : `/payments/${paymentId}/pack#evidence-${i.id}`,
    auto: autoOf(i.id, selected.has(i.id), auto),
  }));
}

async function draftView(
  deps: Deps,
  ws: string,
  disputeRowId: string,
  cur: DraftWithAction,
  allowed: readonly string[],
  paymentId: string | null,
): Promise<Draft | null> {
  const d = cur.draft;
  const kind = d.actionKind;
  // a pre-M2-07 row has no filing action to approve
  if (kind !== "provide_evidence" && kind !== "provide_supporting_info") return null;
  const auto = await disputeDraftsRepo(deps.db, ws as WorkspaceId).autoEvidence(d.id);
  const [items, pdf, action] = await Promise.all([
    draftItems(deps, ws, d, paymentId, auto),
    d.compiledBlobId === null ? null : blobMeta(deps.db, ws, d.compiledBlobId),
    d.proposedActionId === null ? null : getProposedAction(deps.db, ws, d.proposedActionId),
  ]);
  return {
    id: d.id,
    actionKind: kind,
    evidenceType: d.evidenceType,
    reasonUnmapped: d.reasonUnmapped,
    notes: d.notes,
    items,
    pdf:
      pdf === null ? null : { url: `/api/disputes/${disputeRowId}/draft/pdf?draft=${d.id}`, bytes: pdf.size },
    action: action === null ? null : await view(deps, action),
    allowed: allowed.includes(kind),
  };
}

/** Without a draft, the payment's pack items (the seller can still reply in PayPal with them). */
async function packItems(deps: Deps, ws: string, paymentId: string | null): Promise<DraftItem[]> {
  if (paymentId === null) return [];
  const pack = await forWorkspace(deps.db, ws as WorkspaceId).proofPacks.getByPaymentId(paymentId);
  return pack === null ? [] : draftItems(deps, ws, { packId: pack.id, evidenceItemIds: [] }, paymentId);
}

function killSwitchFromEnv(): boolean {
  const r = AgentEnvSchema.shape.AGENT_KILL_SWITCH.safeParse(process.env["AGENT_KILL_SWITCH"]);
  return r.success && r.data;
}

/** `id` is our `disputes.id` or PayPal's dispute id (deep links use either). */
export async function findDispute(deps: Deps, ws: string, id: string) {
  const repos = forWorkspace(deps.db, ws as WorkspaceId);
  if (z.uuid().safeParse(id).success) return repos.disputes.get(id);
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? repos.disputes.getByDisputeId(id) : null;
}

export async function disputeDetail(deps: Deps, ws: string, id: string): Promise<DisputeDetail | null> {
  const d = await findDispute(deps, ws, id);
  if (d === null) return null;
  const p =
    d.paymentId === null ? null : await forWorkspace(deps.db, ws as WorkspaceId).payments.get(d.paymentId);
  const row: DisputeListRow = { dispute: d, payment: p };
  const drafts = (await draftsByDispute(deps, ws, [d.id])).get(d.id) ?? [];
  const allowed = Links.parse(d.allowedActions);
  const cur = currentDraft(drafts, allowed);
  const [draft, outcome, accept, flag, scenarioId, audit, w] = await Promise.all([
    cur === null ? null : draftView(deps, ws, d.id, cur, allowed, d.paymentId),
    cur === null ? latestDraftOutcome(deps.db, ws, d.id) : null,
    latestAcceptClaim(deps.db, ws, d.disputeId),
    platform(deps.db).flags.agentKillSwitch(),
    scenarioForDispute(deps.db, ws, d.disputeId),
    auditPage(deps.db, ws, { dispute: { rowId: d.id, paypalId: d.disputeId }, limit: 100 }),
    platform(deps.db).workspaces.get(ws),
  ]);
  return {
    dispute: {
      ...summary(row, drafts),
      allowedActions: allowed,
      paypalUpdatedAt: d.paypalUpdatedAt?.toISOString() ?? null,
    },
    draft,
    packItems: cur === null ? await packItems(deps, ws, d.paymentId) : [],
    draftOutcome:
      outcome === null
        ? null
        : {
            kind: outcome.action.endsWith("too_late") ? "too_late" : "unavailable",
            code: typeof outcome.detail["code"] === "string" ? outcome.detail["code"] : null,
          },
    acceptClaim: accept === null ? null : await view(deps, accept),
    killSwitch: flag || killSwitchFromEnv(),
    scenarioId,
    audit: audit.rows.map(auditEntry),
    workspace: { timezone: w?.timezone ?? "UTC" },
  };
}
