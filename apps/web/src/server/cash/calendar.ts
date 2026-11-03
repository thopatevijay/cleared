// M3-05 cash calendar read model (cash-calendar.md). Workspace-scoped: holds come through `holdsRepo`
// (only captures this workspace owns in `paypal_resource_owner`), disputes through the workspace's
// dispute list. Released holds are read in the range widened by a day each side (any zone's day fits);
// core resolves every day in the workspace zone and keeps only the range.
import {
  addDays,
  buildCashCalendar,
  defaultCashRange,
  type CashCalendarResponse,
  type CashHoldInput,
  type CashRange,
  type WorkspaceId,
} from "@cleared/core";
import { disputeList, holdsRepo, platform, type HoldView } from "@cleared/db";
import type { Deps } from "../deps.ts";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function holdInput(v: HoldView): CashHoldInput {
  const h = v.hold;
  return {
    id: h.id,
    amount: { value: v.payment.amount, currency: v.payment.currency },
    state: h.state,
    reason: h.reason,
    ruleId: h.estimateSource ?? "reason_OTHER",
    estimatedReleaseAt: iso(h.estimatedReleaseAt),
    releasedAt: iso(h.releasedAt),
  };
}

export async function workspaceTimezone(deps: Deps, ws: string): Promise<string> {
  return (await platform(deps.db).workspaces.get(ws))?.timezone ?? "UTC";
}

/** The range asked for, or the default (the current month in the workspace zone, then 92 days). */
export async function cashCalendar(
  deps: Deps,
  ws: WorkspaceId,
  range: CashRange | null,
): Promise<CashCalendarResponse> {
  const tz = await workspaceTimezone(deps, ws);
  const r = range ?? defaultCashRange(deps.now().toISOString(), tz);
  const repo = holdsRepo(deps.db, ws);
  const from = new Date(`${addDays(r.from, -1)}T00:00:00Z`);
  const to = new Date(`${addDays(r.to, 2)}T00:00:00Z`);
  const [active, released, held, disputes] = await Promise.all([
    repo.listActive(),
    repo.releasedBetween(from, to),
    repo.heldTotals(),
    disputeList(deps.db, ws),
  ]);
  return buildCashCalendar({
    range: r,
    timeZone: tz,
    holds: [...active, ...released].map(holdInput),
    disputes: disputes.map(({ dispute: d }) => ({
      id: d.id,
      status: d.status,
      dueDate: iso(d.sellerResponseDueDate),
      amount:
        d.amount !== null && d.currency !== null ? { value: d.amount, currency: d.currency.trim() } : null,
    })),
    heldNow: held,
  });
}
