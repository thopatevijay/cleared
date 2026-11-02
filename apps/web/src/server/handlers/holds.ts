// M3-01 holds API (hold.md). Every route acts on the session's workspace only:
//   GET  /api/holds                     active holds + the held total per currency (derived holds only)
//   GET  /api/holds/:id                 one hold (any state) with its capture and explanations; 404 when foreign
//   POST /api/holds/:id/explanation     M3-02: `{ locale }` asks for the hold's explanation in that locale
//        200 `{ status: "ready" }` when it exists; 202 `{ status: "requested" }` after writing the
//        `hold.explain_requested` outbox row (the worker explains; no model call inside the request);
//        409 `RELEASED` for a released hold; 404 `NOT_FOUND` when foreign, unowned or not a uuid.
import { fromEpochMs, HoldIdSchema, LOCALES, type Locale, type WorkspaceId } from "@cleared/core";
import { holdsRepo, withTransaction } from "@cleared/db";
import { z } from "zod";
import { checkMutation, readJson } from "../csrf.ts";
import { withIdempotency } from "../idempotency.ts";
import type { Deps } from "../deps.ts";
import { holdDetail, listHolds } from "../holds/read.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";
import { refusal } from "./actions.ts";
import type { PublisherSource } from "./evidence.ts";

export async function getHolds(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  return withRenewal(json(await listHolds(deps, session.workspaceId as WorkspaceId)), session);
}

export async function getHold(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const detail = await holdDetail(deps, session.workspaceId as WorkspaceId, rawId);
  if (detail === null) return refusal(req, 404, "NOT_FOUND", "No such hold in this workspace.");
  return withRenewal(json(detail), session);
}

const ExplanationRequestSchema = z.object({ locale: z.enum(LOCALES) }).strict();

export async function postHoldExplanation(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  rawId: string,
): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const body = ExplanationRequestSchema.safeParse(await readJson(req));
  if (!body.success) return apiError(400, "invalid_request", 'Send { locale: "en" | "hi" }.', correlationId(req));
  const scope = { scopeId: session.sessionId, route: EXPLAIN_ROUTE.replace(":id", rawId), key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, () =>
    requestExplanation(req, deps, publisher, session.workspaceId as WorkspaceId, rawId, body.data.locale),
  ).then((res) => withRenewal(res, session));
}

export const EXPLAIN_ROUTE = "POST /api/holds/:id/explanation";

async function requestExplanation(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  ws: WorkspaceId,
  rawId: string,
  locale: Locale,
): Promise<Response> {
  const detail = await holdDetail(deps, ws, rawId);
  if (detail === null) return refusal(req, 404, "NOT_FOUND", "No such hold in this workspace.");
  if (detail.explanations.some((e) => e.locale === locale)) return json({ status: "ready" });
  if (detail.hold.state === "released")
    return refusal(req, 409, "RELEASED", "This hold is released; there is nothing to explain.");
  const pub = await publisher();
  await withTransaction(deps.db, async (tx) => {
    await holdsRepo(deps.db, ws).lockPayment(detail.hold.paymentId, tx);
    await pub.emit(tx, {
      type: "hold.explain_requested",
      version: 1,
      workspaceId: ws,
      occurredAt: fromEpochMs(deps.now().getTime()),
      data: { holdId: HoldIdSchema.parse(detail.hold.id), locale },
    });
  });
  return json({ status: "requested" }, 202);
}
