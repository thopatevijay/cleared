// BL-01 6570499264 (option A, ADR 0017 addendum 3): the seller's goods/service declaration on each hold, the
// guided action it selects, and whether it is still changeable. The lock reads the newest add_tracking and
// record_service_completed action on the hold's capture: once either reached approval, it is locked.
import {
  declarationLocked,
  declaredKindOf,
  guidedAction,
  canDeclare,
  holdTypeOf,
  type ActionState,
  type Declaration,
  type GuidedAction,
  type LockFacts,
  WorkspaceIdSchema,
} from "@cleared/core";
import {
  forWorkspace,
  holdsRepo,
  trackingReads,
  type Db,
  type Executor,
  type HoldRow,
  type Tx,
} from "@cleared/db";

export interface DeclarationRef {
  readonly hold: Pick<
    HoldRow,
    "id" | "type" | "state" | "completedConfirmedAt" | "sellerDeclaredKind" | "sellerDeclaredAt"
  >;
  readonly payment: { readonly captureId: string };
}

export interface HoldGuidance {
  readonly declaration: Declaration;
  readonly guidedAction: GuidedAction | null;
}

/** The newest guided-action states on each capture (both kinds). */
async function actionStates(
  db: Db,
  ws: string,
  captureIds: readonly string[],
  ex: Executor,
): Promise<Map<string, ActionState[]>> {
  const reads = trackingReads(db, ws);
  const [tracking, record] = await Promise.all([
    reads.latestActionsByCapture("add_tracking", captureIds, ex),
    reads.latestActionsByCapture("record_service_completed", captureIds, ex),
  ]);
  return new Map(
    captureIds.map((c) => [
      c,
      [tracking.get(c)?.state, record.get(c)?.state].filter((s): s is ActionState => s !== undefined),
    ]),
  );
}

export function lockFacts(ref: DeclarationRef, states: readonly ActionState[]): LockFacts {
  return {
    state: ref.hold.state,
    completedConfirmed: ref.hold.completedConfirmedAt !== null,
    actionStates: states,
  };
}

/** The lock facts of one hold, read in the caller's transaction (the declaration route). */
export async function lockFactsFor(
  db: Db,
  ws: string,
  ref: DeclarationRef,
  ex: Executor,
): Promise<LockFacts> {
  const states = await actionStates(db, ws, [ref.payment.captureId], ex);
  return lockFacts(ref, states.get(ref.payment.captureId) ?? []);
}

/**
 * Under the payment's row lock (the declaration route takes the same lock): the hold's guided action now.
 * A proposal route re-checks it here, so a proposal never lands on a hold the seller just re-declared.
 */
export async function guidedUnderLock(
  db: Db,
  ws: string,
  ids: { readonly paymentId: string; readonly holdId: string },
  tx: Tx,
): Promise<GuidedAction | null> {
  await holdsRepo(db, ws).lockPayment(ids.paymentId, tx);
  const h = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).holds.get(ids.holdId, tx);
  return h === null ? null : guidedAction(holdTypeOf(h.type), declaredKindOf(h.sellerDeclaredKind));
}

/** Per hold id: the declaration as the seller sees it and the action slot's guided action. */
export async function holdGuidance(
  db: Db,
  ws: string,
  refs: readonly DeclarationRef[],
  ex: Executor = db,
): Promise<Map<string, HoldGuidance>> {
  const states = await actionStates(
    db,
    ws,
    refs.map((r) => r.payment.captureId),
    ex,
  );
  return new Map(
    refs.map((r) => {
      const type = holdTypeOf(r.hold.type);
      const kind = declaredKindOf(r.hold.sellerDeclaredKind);
      const declaration: Declaration = {
        kind,
        declaredAt: r.hold.sellerDeclaredAt?.toISOString() ?? null,
        declarable: canDeclare(type, r.hold.state),
        locked: declarationLocked(lockFacts(r, states.get(r.payment.captureId) ?? [])),
      };
      return [r.hold.id, { declaration, guidedAction: guidedAction(type, kind) }] as const;
    }),
  );
}
