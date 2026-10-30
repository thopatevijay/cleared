// Shared-limit caps (ADR 0007, M1-05). Demo workspaces: N per IP hash per rolling day and M live in
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
  /** seconds, for `Retry-After` (an upper bound: the full window) */
  readonly retryAfterS: number;
};

/** Call first inside the demo-creating transaction; null means "within caps, go ahead". */
export async function checkDemoCaps(deps: Deps, tx: Tx, ipHash: string): Promise<CapRefusal | null> {
  const auth = platform(deps.db).auth;
  await auth.lockDemoCaps(tx);
  const now = deps.now();
  const fromIp = await auth.countDemoWorkspacesSince(new Date(now.getTime() - DAY_MS), ipHash, tx);
  if (fromIp >= deps.config.demoPerIpPerDay) return { cap: "demo_per_ip", retryAfterS: DAY_MS / 1000 };
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
