// The demo cap's 429 (BL-01 6649565560, landing.md "Per-network cap"): which cap was hit, its limit and
// when the next slot frees, read from the error envelope's `details` (src/server/handlers/capped.ts).
import { minutesFrom, type ApiResult } from "./api.ts";

export interface DemoCap {
  /** the per-network cap (3 per rolling 24 h), not the global "demo is busy" cap */
  readonly perIp: boolean;
  readonly limit: number;
  /** ISO time the next per-network slot frees, or null when the response gave none */
  readonly retryAt: string | null;
  /** the global cap's wait, from Retry-After */
  readonly minutes: number;
  readonly ref: string | null;
}

const DEFAULT_LIMIT = 3;
/** Before `details.cap` existed the per-IP cap answered Retry-After 86400 and the global one 3600. */
const PER_IP_RETRY_S = 3 * 3600;

function detailsOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const d = (body as { error?: { details?: unknown } }).error?.details;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

export function demoCapFrom(res: ApiResult): DemoCap {
  const d = detailsOf(res.body);
  const perIp = typeof d["cap"] === "string" ? d["cap"] === "demo_per_ip" : (res.retryAfter ?? 0) > PER_IP_RETRY_S;
  const limit = typeof d["limit"] === "number" && d["limit"] > 0 ? d["limit"] : DEFAULT_LIMIT;
  const at = typeof d["retryAt"] === "string" ? d["retryAt"] : null;
  // never a time computed from Retry-After alone, and never an unparseable one
  const retryAt = at !== null && Number.isFinite(Date.parse(at)) ? at : null;
  return { perIp, limit, retryAt, minutes: minutesFrom(res.retryAfter), ref: res.correlationId };
}
