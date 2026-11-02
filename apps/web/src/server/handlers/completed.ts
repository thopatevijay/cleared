// M3-04 guided Completed step (hold.md "M3-04 guided Completed step"), on service holds only:
//   POST /api/holds/:id/completed          {confirmed_on: "YYYY-MM-DD"}
//     The seller says they marked the order Completed in PayPal (the web step). In ONE transaction, under the
//     payment's row lock: the hold walks to `filed` (M3-01 machine), `estimate_source = service_completed`,
//     `estimated_release_at = confirmed + 7 days` (help129, labelled estimated), `completed_confirmed_at`, a
//     seller audit row and the `hold.completed_confirmed` outbox row. 200 `{ status: "confirmed", … }`.
//     409 NOT_SERVICE_HOLD / ALREADY_CONFIRMED / NOT_CONFIRMABLE; 422 DATE_IN_FUTURE / DATE_BEFORE_HOLD /
//     INVALID_DATE; 404 NOT_FOUND.
//   POST /api/holds/:id/completed/record   {}
//     The secondary API record: a seller-created `record_service_completed` proposal (capture, COMPLETED).
//     Only a proposal: the seller approves its exact payload_sha256 at POST /api/actions/:id/approve and the
//     worker sends it. It never changes the estimate. 201 `{ action }`; 409 NOT_SERVICE_HOLD /
//     RECORD_NOT_NEEDED / RECORD_IN_PROGRESS; 404 NOT_FOUND.
import {
  CaptureIdSchema,
  confirmServiceCompleted,
  fromEpochMs,
  HoldIdSchema,
  recordServiceCompletedPayload,
  WorkspaceIdSchema,
  type CompletedRefusal,
  type Instant,
} from "@cleared/core";
import {
  forWorkspace,
  holdsRepo,
  insertSellerProposal,
  platform,
  trackingReads,
  withTransaction,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { json } from "../respond.ts";
import { withRenewal } from "../session.ts";
import { actorOf, mutation, refusal, view } from "./actions.ts";
import type { PublisherSource } from "./evidence.ts";
import { supersede } from "./tracking.ts";

type Refusal = readonly [status: number, code: string, message: string];

const NOT_FOUND: Refusal = [404, "NOT_FOUND", "No such hold in this workspace."];

const CONFIRM_REFUSAL: Readonly<Record<CompletedRefusal, Refusal>> = {
  NOT_SERVICE_HOLD: [409, "NOT_SERVICE_HOLD", "The Completed step applies to service payments only."],
  ALREADY_CONFIRMED: [409, "ALREADY_CONFIRMED", "You already confirmed this order as Completed."],
  NOT_CONFIRMABLE: [409, "NOT_CONFIRMABLE", "This hold is released or past this step."],
  DATE_IN_FUTURE: [422, "DATE_IN_FUTURE", "Choose today or an earlier day."],
  DATE_BEFORE_HOLD: [422, "DATE_BEFORE_HOLD", "Choose a day on or after the day the hold started."],
  INVALID_DATE: [422, "INVALID_DATE", "Send the date as YYYY-MM-DD."],
};

const RECORD_REFUSAL = {
  notService: CONFIRM_REFUSAL.NOT_SERVICE_HOLD,
  done: [409, "RECORD_NOT_NEEDED", "This hold is released, or the record is already with PayPal."],
  busy: [409, "RECORD_IN_PROGRESS", "The Completed record for this payment is already being sent."],
} as const satisfies Record<string, Refusal>;

const ConfirmSchema = z.strictObject({ confirmed_on: z.string().min(1).max(32) });

class Refused extends Error {
  readonly r: Refusal;
  constructor(r: Refusal) {
    super(r[1]);
    this.r = r;
  }
}

interface Confirmed {
  readonly confirmedAt: Instant;
  readonly estimatedReleaseAt: Instant;
  readonly state: string;
}

export async function postCompletedConfirm(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  rawId: string,
): Promise<Response> {
  const m = await mutation(req, deps, ConfirmSchema);
  if (m instanceof Response) return m;
  const no = (r: Refusal) => refusal(req, r[0], r[1], r[2]);
  const ws = m.session.workspaceId;
  const v = z.uuid().safeParse(rawId).success ? await holdsRepo(deps.db, ws).view(rawId) : null;
  if (v === null) return no(NOT_FOUND);
  const scope = { scopeId: m.session.sessionId, route: `POST /api/holds/${v.hold.id}/completed`, key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const pub = await publisher();
    const actor = actorOf(m.session);
    try {
      const done = await withTransaction(deps.db, (tx) =>
        confirmIn(
          tx,
          { deps, pub, ws, holdId: v.hold.id, paymentId: v.payment.id },
          m.body.confirmed_on,
          actor,
        ),
      );
      return withRenewal(json({ status: "confirmed", ...done }), m.session);
    } catch (e) {
      if (e instanceof Refused) return no(e.r);
      throw e;
    }
  });
}

interface ConfirmCtx {
  readonly deps: Deps;
  readonly pub: Awaited<ReturnType<PublisherSource>>;
  readonly ws: string;
  readonly holdId: string;
  readonly paymentId: string;
}

/** Under the payment's row lock: re-read the hold, decide (core), write hold + audit + outbox together. */
async function confirmIn(tx: Tx, c: ConfirmCtx, confirmedOn: string, actor: string): Promise<Confirmed> {
  const { deps, ws } = c;
  const holds = holdsRepo(deps.db, ws);
  const payment = await holds.lockPayment(c.paymentId, tx);
  const repos = forWorkspace(deps.db, WorkspaceIdSchema.parse(ws));
  const hold = await repos.holds.get(c.holdId, tx);
  if (payment === null || hold === null) throw new Refused(NOT_FOUND);
  const tz = (await platform(deps.db).workspaces.get(ws))?.timezone ?? "UTC";
  const now = fromEpochMs(deps.now().getTime());
  const r = confirmServiceCompleted({
    hold: {
      type: hold.type === "service" ? "service" : "other",
      state: hold.state,
      openedAt: fromEpochMs(hold.openedAt.getTime()),
      completedConfirmedAt:
        hold.completedConfirmedAt === null ? null : fromEpochMs(hold.completedConfirmedAt.getTime()),
    },
    confirmedOn,
    now,
    timeZone: tz,
  });
  if (!r.ok) throw new Refused(CONFIRM_REFUSAL[r.error]);
  const { confirmedAt, estimate, state } = r.value;
  await repos.holds.update(
    hold.id,
    {
      state,
      estimateSource: r.value.ruleId,
      estimatedReleaseAt: new Date(estimate.at),
      completedConfirmedAt: new Date(confirmedAt),
    },
    tx,
  );
  await repos.auditLog.insert(
    {
      actor: "seller",
      action: "hold.completed_confirmed",
      detail: {
        holdId: hold.id,
        from: hold.state,
        to: state,
        confirmedAt,
        estimatedReleaseAt: estimate.at,
        by: actor,
      },
    },
    tx,
  );
  await c.pub.emit(tx, {
    type: "hold.completed_confirmed",
    version: 1,
    workspaceId: WorkspaceIdSchema.parse(ws),
    occurredAt: now,
    data: {
      holdId: HoldIdSchema.parse(hold.id),
      captureId: CaptureIdSchema.parse(payment.captureId),
      confirmedAt,
      estimatedReleaseAt: estimate.at,
    },
  });
  return { confirmedAt, estimatedReleaseAt: estimate.at, state };
}

const IN_FLIGHT = new Set(["approved", "executing", "unknown"]);

export async function postCompletedRecord(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, z.strictObject({}));
  if (m instanceof Response) return m;
  const no = (r: Refusal) => refusal(req, r[0], r[1], r[2]);
  const ws = m.session.workspaceId;
  const v = z.uuid().safeParse(rawId).success ? await holdsRepo(deps.db, ws).view(rawId) : null;
  if (v === null) return no(NOT_FOUND);
  if (v.hold.type !== "service") return no(RECORD_REFUSAL.notService);
  if (v.hold.state === "released") return no(RECORD_REFUSAL.done);
  const payload = recordServiceCompletedPayload(v.payment.captureId);
  const scope = {
    scopeId: m.session.sessionId,
    route: `POST /api/holds/${v.hold.id}/completed/record`,
    key: m.key,
  };
  return withIdempotency(req, deps, scope, async () => {
    const prev = (
      await trackingReads(deps.db, ws).latestActionsByCapture("record_service_completed", [
        v.payment.captureId,
      ])
    ).get(v.payment.captureId);
    if (prev?.state === "succeeded") return no(RECORD_REFUSAL.done);
    if (prev !== undefined && IN_FLIGHT.has(prev.state)) return no(RECORD_REFUSAL.busy);
    const actor = actorOf(m.session);
    const row = await withTransaction(deps.db, async (tx) => {
      const created = await insertSellerProposal(
        deps.db,
        {
          workspaceId: ws,
          proposedBy: actor,
          kind: "record_service_completed",
          payload,
          detail: { holdId: v.hold.id },
        },
        tx,
      );
      if (prev?.state === "proposed") await supersede(deps.db, prev, created.id, actor, tx);
      return created;
    });
    return withRenewal(json({ action: await view(deps, row) }, 201), m.session);
  });
}
