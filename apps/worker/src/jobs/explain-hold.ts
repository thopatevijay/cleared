// Hold explanations (M3-02): `explain_hold@v1` on the M2-02 harness, or the standard text when the AI is off,
// over budget, down, or its answer failed the guardrails twice. The explanation is written in the delivery's
// transaction with the hold's `open → explained` move and the `hold.explained` outbox row.
// - triggers: `hold.opened` (the workspace's locale) and `hold.explain_requested` (the seller switched the
//   hold detail to a locale that has no explanation yet).
// - idempotent per (hold, locale): a re-delivery, or a request for a locale already explained, writes nothing.
// - a released hold, or one this workspace doesn't own, is skipped (nothing to explain).
// - the model run commits on its own (agent_runs / agent_steps), like every harness run.
import { explainHold, type ExplainHoldResult } from "@cleared/adapters";
import {
  DomainEventSchema,
  fromEpochMs,
  HoldIdSchema,
  transitionHold,
  type AgentConfig,
  type AiProvider,
  type HoldFacts,
  type Locale,
  type WorkspaceId,
} from "@cleared/core";
import {
  createRunStore,
  forWorkspace,
  holdsRepo,
  platform,
  type Db,
  type HoldView,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { ConsumeContext, Handler } from "../consume.ts";

export interface ExplainHoldDeps {
  readonly db: Db;
  readonly provider: AiProvider;
  readonly config: AgentConfig;
  readonly publisher: Pick<Publisher, "emit">;
  readonly now: () => Date;
}

export type ExplainSkip = "hold_not_found" | "released" | "workspace_not_found";

export type ExplainOutcome =
  | {
      readonly status: "written";
      readonly explanationId: string;
      readonly locale: Locale;
      readonly origin: "ai" | "standard";
      readonly runId: string | null;
      readonly runStatus: ExplainHoldResult["runStatus"];
      readonly fallbackReason: string | null;
    }
  | { readonly status: "exists"; readonly explanationId: string }
  | { readonly status: "skipped"; readonly reason: ExplainSkip };

type Ctx = Pick<ConsumeContext, "tx" | "log" | "envelope">;

export function explainHoldHandler(deps: ExplainHoldDeps): Handler {
  return async (data, ctx) => {
    const out = await explainForEvent(deps, data, ctx);
    ctx.log.info({ outcome: out }, "hold explanation");
  };
}

/** `hold.opened` explains in the workspace's locale; `hold.explain_requested` in the locale asked for. */
export async function explainForEvent(
  deps: ExplainHoldDeps,
  data: unknown,
  ctx: Ctx,
): Promise<ExplainOutcome> {
  const e = DomainEventSchema.parse(data);
  if (e.type !== "hold.opened" && e.type !== "hold.explain_requested")
    throw new Error(`explain-hold: unexpected event ${e.type}`);
  const workspace = await platform(deps.db).workspaces.get(e.workspaceId, ctx.tx);
  if (workspace === null) return { status: "skipped", reason: "workspace_not_found" };
  const locale = e.type === "hold.explain_requested" ? e.data.locale : workspace.locale;
  return explainHoldIn(deps, e.workspaceId, e.data.holdId, locale, workspace.timezone, ctx);
}

const existing = async (deps: ExplainHoldDeps, ws: WorkspaceId, holdId: string, locale: Locale, tx: Tx) =>
  (await holdsRepo(deps.db, ws).explanations(holdId, tx)).find((x) => x.locale === locale) ?? null;

export function holdFacts(v: HoldView, timeZone: string): HoldFacts {
  const at = (d: Date) => fromEpochMs(d.getTime());
  return {
    ruleId: v.hold.estimateSource ?? "reason_OTHER",
    reason: v.hold.reason,
    amount: { value: v.payment.amount, currency: v.payment.currency },
    openedAt: at(v.hold.openedAt),
    estimatedReleaseAt: v.hold.estimatedReleaseAt === null ? null : at(v.hold.estimatedReleaseAt),
    timeZone,
  };
}

export async function explainHoldIn(
  deps: ExplainHoldDeps,
  ws: WorkspaceId,
  holdId: string,
  locale: Locale,
  timeZone: string,
  ctx: Ctx,
): Promise<ExplainOutcome> {
  const view = await holdsRepo(deps.db, ws).view(holdId, ctx.tx);
  if (view === null) return { status: "skipped", reason: "hold_not_found" };
  if (view.hold.state === "released") return { status: "skipped", reason: "released" };
  const found = await existing(deps, ws, holdId, locale, ctx.tx);
  if (found !== null) return { status: "exists", explanationId: found.id };
  const result = await explainHold(
    {
      provider: deps.provider,
      store: createRunStore(deps.db),
      config: deps.config,
      workspaceId: ws,
      correlationId: ctx.envelope.correlationId,
    },
    holdFacts(view, timeZone),
    locale,
  );
  return write(deps, ws, view, locale, result, ctx.tx);
}

/** One transaction (the delivery's): explanation row, the hold's `open → explained` move, the outbox row. */
async function write(
  deps: ExplainHoldDeps,
  ws: WorkspaceId,
  view: HoldView,
  locale: Locale,
  r: ExplainHoldResult,
  tx: Tx,
): Promise<ExplainOutcome> {
  const repos = forWorkspace(deps.db, ws);
  await holdsRepo(deps.db, ws).lockPayment(view.payment.id, tx); // serial with the holds consumer
  const raced = await existing(deps, ws, view.hold.id, locale, tx);
  if (raced !== null) return { status: "exists", explanationId: raced.id };
  const hold = await repos.holds.get(view.hold.id, tx);
  if (hold === null || hold.state === "released") return { status: "skipped", reason: "released" };
  const row = await repos.explanations.insert(
    { holdId: hold.id, locale, text: JSON.stringify(r.explanation), sourceRef: r.explanation.ruleId },
    tx,
  );
  const next = transitionHold(hold.state, "explanation_written");
  if (next.ok) await repos.holds.update(hold.id, { state: next.value }, tx); // a re-explanation keeps the state
  await deps.publisher.emit(tx, {
    type: "hold.explained",
    version: 1,
    workspaceId: ws,
    occurredAt: fromEpochMs(deps.now().getTime()),
    data: {
      holdId: HoldIdSchema.parse(hold.id),
      explanationId: row.id,
      locale,
      origin: r.explanation.origin,
    },
  });
  return {
    status: "written",
    explanationId: row.id,
    locale,
    origin: r.explanation.origin,
    runId: r.runId,
    runStatus: r.runStatus,
    fallbackReason: r.fallbackReason,
  };
}
