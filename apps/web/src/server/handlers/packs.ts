// GET /api/packs/:packId (M2-05): one proof pack of the session's workspace, as the pack page shows it.
// A pack of another workspace is a 404, indistinguishable from one that does not exist. The page server
// component reads the same view (`loadPackView`) for its first render; the client then polls this route.
import {
  EXTRACT_PROMPT,
  packViewState,
  parseClientAckText,
  quoteInContext,
  scanForInjection,
  type PackCitation,
  type PackView,
  type StoredCitation,
  type WorkspaceId,
} from "@cleared/core";
import {
  evidenceRepo,
  extractedFactsRepo,
  forWorkspace,
  packReadsRepo,
  platform,
  scopeChecksRepo,
  type ExtractedFactsRow,
  type ScopeCheckRow,
} from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { toEvidenceItem } from "./evidence.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";

const IdSchema = z.uuid();

function citation(c: StoredCitation, texts: ReadonlyMap<string, string | null>): PackCitation {
  return {
    evidenceItemId: c.evidence_item_id,
    quote: c.quote,
    offsets: c.offsets,
    context: quoteInContext(texts.get(c.evidence_item_id) ?? null, c.offsets, c.quote),
  };
}

function checkOf(rows: readonly ScopeCheckRow[], stale: boolean, texts: ReadonlyMap<string, string | null>) {
  const first = rows[0];
  if (first === undefined) return null;
  return {
    version: first.checkVersion,
    at: first.createdAt.toISOString(),
    previous: stale,
    verdicts: rows.map((r) => ({
      lineId: r.lineId,
      line: r.line,
      verdict: r.verdict,
      note: r.note,
      rationale: r.rationale,
      lineCitation: r.lineCitation === null ? null : citation(r.lineCitation, texts),
      citations: r.citations.map((c) => citation(c, texts)),
    })),
  };
}

const flaggedBy = (facts: readonly ExtractedFactsRow[]): Set<string> =>
  new Set(facts.filter((f) => f.facts.instruction_like_lines.length > 0).map((f) => f.evidenceItemId));

/** The pack page's data, or null when the pack is not this workspace's. */
export async function loadPackView(deps: Deps, ws: WorkspaceId, packId: string): Promise<PackView | null> {
  if (!IdSchema.safeParse(packId).success) return null;
  const status = await packReadsRepo(deps.db, ws).forPack(packId);
  if (status === null) return null;
  const [payment, items, facts, rows, workspace] = await Promise.all([
    forWorkspace(deps.db, ws).payments.get(status.paymentId),
    evidenceRepo(deps.db, ws).items.listForPack(packId),
    extractedFactsRepo(deps.db, ws).listForPack(packId, EXTRACT_PROMPT.id),
    scopeChecksRepo(deps.db, ws).latestForPack(packId),
    platform(deps.db).workspaces.get(ws),
  ]);
  if (payment === null) return null;
  const texts = new Map(items.map((i) => [i.id, i.text]));
  const reported = flaggedBy(facts);
  return {
    pack: {
      id: status.packId,
      paymentId: status.paymentId,
      state: status.state,
      view: packViewState(status),
      checkedAt: status.checkedAt?.toISOString() ?? null,
    },
    payment: {
      id: payment.id,
      captureId: payment.captureId,
      orderId: payment.orderId,
      amount: { value: payment.amount, currency: payment.currency },
      receivable:
        payment.receivableAmount !== null && payment.receivableCurrency !== null
          ? { value: payment.receivableAmount, currency: payment.receivableCurrency }
          : null,
      status: payment.status,
      statusReason: payment.statusReason,
      source: payment.source,
      capturedAt: payment.createdAt.toISOString(),
    },
    check: checkOf(rows, status.state === "stale", texts),
    facts: facts.map((f) => ({ evidenceItemId: f.evidenceItemId, facts: f.facts })),
    evidence: items.map((i) => ({
      ...toEvidenceItem(i, i),
      injectionFlagged: reported.has(i.id) || (i.text !== null && scanForInjection(i.id, i.text).length > 0),
      clientAck: i.kind === "client_ack" && i.text !== null ? parseClientAckText(i.text) : null,
    })),
    workspace: { timezone: workspace?.timezone ?? "UTC" },
  };
}

/** The pack of a payment (the page URL names the payment), or null when either is not this workspace's. */
export async function packIdForPayment(
  deps: Deps,
  ws: WorkspaceId,
  paymentId: string,
): Promise<string | null> {
  if (!IdSchema.safeParse(paymentId).success) return null;
  const pack = await forWorkspace(deps.db, ws).proofPacks.getByPaymentId(paymentId);
  return pack?.id ?? null;
}

export async function getPack(req: Request, deps: Deps, packId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const view = await loadPackView(deps, session.workspaceId as WorkspaceId, packId);
  if (view === null) return apiError(404, "not_found", "Proof pack not found.", correlationId(req));
  return withRenewal(json(view), session);
}
