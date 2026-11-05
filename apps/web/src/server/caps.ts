// Shared-limit caps (ADR 0007, M1-05). Demo workspaces: N per IP hash per rolling 24 h and M live in
// total, checked under a transaction-scoped advisory lock so concurrent requests cannot overshoot.
// Magic links: 5 per email and 20 per IP hash per rolling hour, counted from `magic_links`.
import { platform, type Tx } from "@cleared/db";
import type { Deps } from "./deps.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MAGIC_LINKS_PER_EMAIL_PER_HOUR = 5;
export const MAGIC_LINKS_PER_IP_PER_HOUR = 20;

export type CapRefusal = {
  readonly cap: "demo_per_ip" | "demo_global" | "magic_link_per_email" | "magic_link_per_ip";
  /** seconds, for `Retry-After`: exact for the per-IP demo cap, otherwise an upper bound (the full window) */
  readonly retryAfterS: number;
  /** demo_per_ip only: when the oldest counted workspace leaves the rolling 24 h window (BL-01 6649565560) */
  readonly retryAt?: Date;
  /** demo_per_ip only: the limit that was hit */
  readonly limit?: number;
};

/**
 * When a rolling-window cap frees its next slot: `times` (oldest first, all inside the window) hold at
 * least `limit` entries, and one slot frees when the `times.length - limit + 1`-th oldest ages out.
 */
export function nextSlotAt(times: readonly Date[], limit: number, windowMs: number): Date | null {
  const t = times[times.length - limit];
  return limit < 1 || t === undefined ? null : new Date(t.getTime() + windowMs);
}

/** Call first inside the demo-creating transaction; null means "within caps, go ahead". */
export async function checkDemoCaps(deps: Deps, tx: Tx, ipHash: string): Promise<CapRefusal | null> {
  const auth = platform(deps.db).auth;
  await auth.lockDemoCaps(tx);
  const now = deps.now();
  const limit = deps.config.demoPerIpPerDay;
  const fromIp = await auth.demoWorkspaceTimesSince(new Date(now.getTime() - DAY_MS), ipHash, tx);
  if (fromIp.length >= limit) {
    const retryAt = nextSlotAt(fromIp, limit, DAY_MS) ?? new Date(now.getTime() + DAY_MS);
    const retryAfterS = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
    return { cap: "demo_per_ip", retryAfterS, retryAt, limit };
  }
  const live = await auth.countLiveDemoWorkspaces(now, tx);
  if (live >= deps.config.demoGlobalMax) return { cap: "demo_global", retryAfterS: HOUR_MS / 1000 };
  return null;
}

export async function checkMagicLinkCaps(
  deps: Deps,
  email: string,
  ipHash: string,
): Promise<CapRefusal | null> {
  const auth = platform(deps.db).auth;
  const since = new Date(deps.now().getTime() - HOUR_MS);
  const retryAfterS = HOUR_MS / 1000;
  if ((await auth.countMagicLinksSince({ ipHash }, since)) >= MAGIC_LINKS_PER_IP_PER_HOUR) {
    return { cap: "magic_link_per_ip", retryAfterS };
  }
  if ((await auth.countMagicLinksSince({ email }, since)) >= MAGIC_LINKS_PER_EMAIL_PER_HOUR) {
    return { cap: "magic_link_per_email", retryAfterS };
  }
  return null;
}
