// BL-01 6570499264 (owner decision 2026-11-03, option A; ADR 0017 addendum 3):
//   POST /api/holds/:id/declaration   {kind: "goods" | "service"}
// The seller says what they sold. Stored on the hold as the seller's declaration (kind, who, when) with a
// `hold.declared` seller audit row, in ONE transaction under the payment's row lock. It never touches the
// hold's PayPal type, reason, state or estimate: it only selects the guided action (goods → tracking,
// service → the guided Completed step). Changing it rejects a still-`proposed` action of the other kind.
//   200 `{ declaration, guidedAction }` (also when nothing changed); 404 NOT_FOUND;
//   409 NOT_DECLARABLE (PayPal already typed the hold, it is released, or a sample) / DECLARATION_LOCKED
//   (an action was approved or Completed confirmed); 400 invalid body.
import {
  decideDeclaration,
  declaredKindOf,
  DeclareBodySchema,
  guidedAction,
  holdTypeOf,
  WorkspaceIdSchema,
  type DeclarationRefusal,
  type DeclaredKind,
  type HoldActionKind,
} from "@cleared/core";
import {
  appendActionAudit,
  forWorkspace,
  holdsRepo,
  setProposedActionState,
  trackingReads,
  withTransaction,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { holdGuidance, lockFactsFor } from "../holds/declaration.ts";
import { withIdempotency } from "../idempotency.ts";
import { json } from "../respond.ts";
import { withRenewal } from "../session.ts";
import { actorOf, mutation, refusal } from "./actions.ts";

type Refusal = readonly [status: number, code: string, message: string];

const NOT_FOUND: Refusal = [404, "NOT_FOUND", "No such hold in this workspace."];
const REFUSALS: Readonly<Record<DeclarationRefusal, Refusal>> = {
  NOT_DECLARABLE: [409, "NOT_DECLARABLE", "This hold can't take a goods or service declaration."],
  DECLARATION_LOCKED: [
    409,
    "DECLARATION_LOCKED",
    "You approved an action on this payment, so what you sold can't change now.",
  ],
};

class Refused extends Error {
  readonly r: Refusal;
  constructor(r: Refusal) {
    super(r[1]);
    this.r = r;
  }
}

/** The action a declaration of `kind` no longer selects. */
const OTHER_KIND: Readonly<Record<DeclaredKind, HoldActionKind>> = {
  goods: "record_service_completed",
  service: "add_tracking",
};

interface Ctx {
  readonly deps: Deps;
  readonly ws: string;
  readonly holdId: string;
  readonly paymentId: string;
  readonly actor: string;
}

/** A still-proposed action of the other kind → rejected (the approval would bind the old declaration). */
async function rejectOther(c: Ctx, captureId: string, kind: DeclaredKind, tx: Tx): Promise<void> {
  const other = OTHER_KIND[kind];
  const prev = (await trackingReads(c.deps.db, c.ws).latestActionsByCapture(other, [captureId], tx)).get(
    captureId,
  );
  if (prev?.state !== "proposed") return;
  const moved = await setProposedActionState(
    c.deps.db,
    c.ws,
    prev.id,
    { from: "proposed", to: "rejected" },
    tx,
  );
  // approved meanwhile: the declaration is locked after all
  if (!moved) throw new Refused(REFUSALS.DECLARATION_LOCKED);
  const detail = { reason: "declaration_changed", by: c.actor };
  await appendActionAudit(
    c.deps.db,
    { workspaceId: c.ws, actionId: prev.id, actor: "seller", action: "action.rejected", detail },
    tx,
  );
}

/** Under the payment's row lock: re-read the hold and its lock facts, decide (core), write hold + audit. */
async function declareIn(c: Ctx, kind: DeclaredKind, tx: Tx): Promise<void> {
  const repos = forWorkspace(c.deps.db, WorkspaceIdSchema.parse(c.ws));
  const payment = await holdsRepo(c.deps.db, c.ws).lockPayment(c.paymentId, tx);
  const hold = await repos.holds.get(c.holdId, tx);
  if (payment === null || hold === null) throw new Refused(NOT_FOUND);
  const current = declaredKindOf(hold.sellerDeclaredKind);
  const lock = await lockFactsFor(c.deps.db, c.ws, { hold, payment }, tx);
  const r = decideDeclaration({ type: holdTypeOf(hold.type), lock, current, next: kind });
  if (!r.ok) throw new Refused(REFUSALS[r.error]);
  if (!r.value.changed) return;
  const at = c.deps.now();
  await repos.holds.update(
    hold.id,
    { sellerDeclaredKind: kind, sellerDeclaredBy: c.actor, sellerDeclaredAt: at },
    tx,
  );
  await rejectOther(c, payment.captureId, kind, tx);
  await repos.auditLog.insert(
    {
      actor: "seller",
      action: "hold.declared",
      detail: {
        holdId: hold.id,
        paymentId: payment.id,
        kind,
        from: current,
        to: kind,
        reason: hold.reason,
        by: c.actor,
        declaredAt: at.toISOString(),
      },
    },
    tx,
  );
}

export async function postDeclaration(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, DeclareBodySchema);
  if (m instanceof Response) return m;
  const no = (r: Refusal) => refusal(req, r[0], r[1], r[2]);
  const ws = m.session.workspaceId;
  const v = z.uuid().safeParse(rawId).success ? await holdsRepo(deps.db, ws).view(rawId) : null;
  if (v === null) return no(NOT_FOUND);
  const scope = {
    scopeId: m.session.sessionId,
    route: `POST /api/holds/${v.hold.id}/declaration`,
    key: m.key,
  };
  return withIdempotency(req, deps, scope, async () => {
    const c = { deps, ws, holdId: v.hold.id, paymentId: v.payment.id, actor: actorOf(m.session) };
    try {
      await withTransaction(deps.db, (tx) => declareIn(c, m.body.kind, tx));
    } catch (e) {
      if (e instanceof Refused) return no(e.r);
      throw e;
    }
    const after = await holdsRepo(deps.db, ws).view(v.hold.id);
    if (after === null) return no(NOT_FOUND);
    const g = (await holdGuidance(deps.db, ws, [after])).get(after.hold.id);
    const type = holdTypeOf(after.hold.type);
    const guided = guidedAction(type, declaredKindOf(after.hold.sellerDeclaredKind));
    return withRenewal(json({ declaration: g?.declaration ?? null, guidedAction: guided }), m.session);
  });
}
