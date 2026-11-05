// The 429 every cap refusal returns (plain message + Retry-After), after its `audit_log` row.
import { platform, type Executor } from "@cleared/db";
import type { CapRefusal } from "../caps.ts";
import type { Deps } from "../deps.ts";
import { apiError, correlationId } from "../respond.ts";

const MESSAGES: Readonly<Record<CapRefusal["cap"], string>> = {
  demo_per_ip: "This network has made the most demo workspaces allowed in a rolling 24 hours. Try again when the next one frees (see Retry-After).",
  demo_global: "The demo is full right now. Try again in an hour.",
  magic_link_per_email: "Too many sign-in links were requested for this address. Try again in an hour.",
  magic_link_per_ip: "Too many sign-in links were requested from this network. Try again in an hour.",
};

/** Writes the refusal to `audit_log` (actor system, no workspace) and returns the 429. */
export async function capped(
  deps: Deps,
  req: Request,
  refusal: CapRefusal,
  ipHashHex: string,
  tx?: Executor,
): Promise<Response> {
  await platform(deps.db).auth.auditSystem(
    { workspaceId: null, action: "cap.refused", detail: { cap: refusal.cap, ipHash: ipHashHex } },
    tx,
  );
  return apiError(429, "rate_limited", MESSAGES[refusal.cap], correlationId(req), {
    "retry-after": String(refusal.retryAfterS),
  }, capDetails(refusal));
}

/** BL-01 6649565560: which cap, and for the per-IP demo cap the limit, window and when the next slot frees. */
function capDetails(refusal: CapRefusal): Record<string, unknown> {
  if (refusal.retryAt === undefined) return { cap: refusal.cap };
  return { cap: refusal.cap, limit: refusal.limit, windowHours: 24, retryAt: refusal.retryAt.toISOString() };
}
