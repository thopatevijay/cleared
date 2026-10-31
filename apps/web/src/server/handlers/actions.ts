// M2-08 action governance API (ADR 0010). Every route acts on the session's workspace only; ids and
// bodies are zod-parsed; mutations need JSON + Origin + Idempotency-Key (csrf.ts) and replay per key.
//   GET  /api/actions/:id                          payload, payload_sha256, state, refusal code
//   POST /api/actions/:id/approve                  {payload_sha256, typed_confirmation?}
//   POST /api/actions/:id/reject                   {}
//   POST /api/disputes/:id/accept-claim-proposal   {note}  (seller-created accept_claim only)
// The approval and its execution job commit in one transaction (`approveProposedAction`); the PayPal
// call itself only ever happens in the worker's `action.execute`.
import {
  AcceptClaimPayloadSchema,
  errorEnvelope,
  Sha256Schema,
  typedConfirmationFor,
  WorkspaceIdSchema,
  type ApprovalRefusal,
} from "@cleared/core";
import {
  approvalForAction,
  approveProposedAction,
  executionForAction,
  forWorkspace,
  getProposedAction,
  insertSellerProposal,
  rejectProposedAction,
  withTransaction,
  type ProposedActionRow,
  type Publisher,
} from "@cleared/db";
import { z } from "zod";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, CORRELATION_HEADER, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal, type Session } from "../session.ts";

const IdSchema = z.uuid();
const ApproveBodySchema = z.strictObject({
  payload_sha256: Sha256Schema,
  typed_confirmation: z.string().max(64).optional(),
});
const RejectBodySchema = z.strictObject({});
const AcceptClaimBodySchema = z.strictObject({ note: z.string().trim().min(1).max(2000) });

/** Seller-facing status per refusal code. */
const REFUSAL_STATUS: Readonly<Record<ApprovalRefusal | "NOT_FOUND", number>> = {
  NOT_FOUND: 404,
  ACTION_NOT_PROPOSED: 409,
  APPROVAL_HASH_MISMATCH: 409,
  UNKNOWN_ACTION_KIND: 422,
  INVALID_PAYLOAD: 422,
  AGENT_ACCEPT_CLAIM_FORBIDDEN: 403,
  TYPED_CONFIRMATION_REQUIRED: 422,
  TYPED_CONFIRMATION_MISMATCH: 422,
};

const REFUSAL_MESSAGE: Readonly<Record<ApprovalRefusal | "NOT_FOUND", string>> = {
  NOT_FOUND: "No such action in this workspace.",
  ACTION_NOT_PROPOSED: "This action is no longer waiting for a decision.",
  APPROVAL_HASH_MISMATCH:
    "The draft changed since you reviewed it. Review the current version and approve again.",
  UNKNOWN_ACTION_KIND: "Cleared cannot carry out this kind of action.",
  INVALID_PAYLOAD: "This action is not valid and cannot be approved.",
  AGENT_ACCEPT_CLAIM_FORBIDDEN: "Only you can propose accepting a claim; the agent never can.",
  TYPED_CONFIRMATION_REQUIRED: "Type the dispute amount and currency to accept the claim.",
  TYPED_CONFIRMATION_MISMATCH: "The amount you typed does not match the dispute amount.",
};

export interface ActionView {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly risk: string;
  readonly createdBy: "agent" | "seller";
  readonly payload: unknown;
  readonly payload_sha256: string;
  /** the seller-facing code of a `failed` action (KILL_SWITCH, DEADLINE_PASSED, …) */
  readonly refusal: string | null;
  /** for accept_claim: what the seller must type, e.g. `120.00 USD` */
  readonly typedConfirmation: string | null;
  readonly approval: { readonly approvedAt: string } | null;
  readonly execution: { readonly paypalStatus: string | null; readonly paypalDebugId: string | null } | null;
}

async function view(deps: Deps, row: ProposedActionRow): Promise<ActionView> {
  const [approval, execution] = await Promise.all([
    approvalForAction(deps.db, row.workspaceId, row.id),
    executionForAction(deps.db, row.workspaceId, row.id),
  ]);
  const accept = row.kind === "accept_claim" ? AcceptClaimPayloadSchema.safeParse(row.payload) : null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    risk: row.risk,
    createdBy: row.createdByRunId === null ? "seller" : "agent",
    payload: row.payload,
    payload_sha256: row.payloadSha256,
    refusal: row.refusalCode,
    typedConfirmation: accept?.success === true ? typedConfirmationFor(accept.data.amount) : null,
    approval: approval === null ? null : { approvedAt: approval.approvedAt.toISOString() },
    execution:
      execution === null
        ? null
        : { paypalStatus: execution.paypalStatus, paypalDebugId: execution.paypalDebugId },
  };
}

const actorOf = (s: Session): string => s.userId ?? s.sessionId;

/**
 * A refusal in the ADR 0003 envelope: `code` is the snake_case form (`approval_hash_mismatch`) and
 * `details.refusal` the governance code itself (`APPROVAL_HASH_MISMATCH`), which M2-09 renders.
 */
function refusal(req: Request, status: number, code: string, message: string): Response {
  const cid = correlationId(req);
  const body = errorEnvelope({
    code: code.toLowerCase(),
    message,
    details: { refusal: code },
    correlationId: cid,
  });
  return json(body, status, { [CORRELATION_HEADER]: cid });
}

function notFound(req: Request): Response {
  return refusal(req, 404, "NOT_FOUND", REFUSAL_MESSAGE.NOT_FOUND);
}

export async function getAction(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const id = IdSchema.safeParse(rawId);
  const row = id.success ? await getProposedAction(deps.db, session.workspaceId, id.data) : null;
  if (row === null) return notFound(req);
  return withRenewal(json({ action: await view(deps, row) }), session);
}

interface Mutation<B> {
  readonly session: Session;
  readonly body: B;
  readonly key: string;
}

/** CSRF, session and body checks shared by the POST routes; a Response when any fails. */
async function mutation<B>(req: Request, deps: Deps, schema: z.ZodType<B>): Promise<Mutation<B> | Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return apiError(400, "invalid_request", z.prettifyError(body.error), correlationId(req));
  }
  return { session, body: body.data, key: check.idempotencyKey };
}

async function decided(
  req: Request,
  deps: Deps,
  session: Session,
  r: Awaited<ReturnType<typeof rejectProposedAction>>,
): Promise<Response> {
  if (!r.ok) return refusal(req, REFUSAL_STATUS[r.code], r.code, REFUSAL_MESSAGE[r.code]);
  return withRenewal(json({ action: await view(deps, r.action) }), session);
}

export async function postApprove(
  req: Request,
  deps: Deps,
  publisher: () => Promise<Publisher>,
  rawId: string,
): Promise<Response> {
  const m = await mutation(req, deps, ApproveBodySchema);
  if (m instanceof Response) return m;
  const id = IdSchema.safeParse(rawId);
  if (!id.success) return notFound(req);
  const scope = { scopeId: m.session.sessionId, route: `POST /api/actions/${id.data}/approve`, key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const r = await approveProposedAction(deps.db, await publisher(), {
      workspaceId: m.session.workspaceId,
      actionId: id.data,
      actor: actorOf(m.session),
      now: deps.now(),
      payloadSha256: m.body.payload_sha256,
      typedConfirmation: m.body.typed_confirmation,
    });
    return decided(req, deps, m.session, r);
  });
}

export async function postReject(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, RejectBodySchema);
  if (m instanceof Response) return m;
  const id = IdSchema.safeParse(rawId);
  if (!id.success) return notFound(req);
  const scope = { scopeId: m.session.sessionId, route: `POST /api/actions/${id.data}/reject`, key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const r = await rejectProposedAction(deps.db, {
      workspaceId: m.session.workspaceId,
      actionId: id.data,
      actor: actorOf(m.session),
      now: deps.now(),
    });
    return decided(req, deps, m.session, r);
  });
}

/**
 * A seller-created `accept_claim` proposal on one of the workspace's disputes (`disputes.id`). It binds
 * the dispute amount into the payload; approving it then needs that amount typed exactly.
 */
export async function postAcceptClaimProposal(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, AcceptClaimBodySchema);
  if (m instanceof Response) return m;
  const id = IdSchema.safeParse(rawId);
  const repos = forWorkspace(deps.db, WorkspaceIdSchema.parse(m.session.workspaceId));
  const dispute = id.success ? await repos.disputes.get(id.data) : null;
  if (dispute === null) return refusal(req, 404, "NOT_FOUND", "No such dispute in this workspace.");
  if (!z.array(z.string()).catch([]).parse(dispute.allowedActions).includes("accept_claim")) {
    return refusal(req, 409, "ACTION_LINK_MISSING", "PayPal does not offer accepting this claim right now.");
  }
  if (dispute.amount === null || dispute.currency === null) {
    return refusal(
      req,
      409,
      "DISPUTE_AMOUNT_UNKNOWN",
      "The dispute amount is not known yet. Try again shortly.",
    );
  }
  const payload = AcceptClaimPayloadSchema.parse({
    dispute_id: dispute.disputeId,
    note: m.body.note,
    amount: { value: dispute.amount, currency_code: dispute.currency.trim() },
    accept_claim_type: "REFUND",
  });
  const scope = {
    scopeId: m.session.sessionId,
    route: `POST /api/disputes/${dispute.id}/accept-claim-proposal`,
    key: m.key,
  };
  return withIdempotency(req, deps, scope, async () => {
    const row = await withTransaction(deps.db, (tx) =>
      insertSellerProposal(
        deps.db,
        { workspaceId: m.session.workspaceId, proposedBy: actorOf(m.session), kind: "accept_claim", payload },
        tx,
      ),
    );
    return withRenewal(json({ action: await view(deps, row) }, 201), m.session);
  });
}
