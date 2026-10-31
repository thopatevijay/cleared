// M2-09: an `audit_log` row as the seller sees it. Only allow-listed scalar detail fields leave the server
// (codes, statuses, PayPal ids, hashes): never notes, evidence text, buyer messages or model output, and
// every string is capped. The UI renders them as plain text.
import type { AuditPageRow } from "@cleared/db";
import type { AuditEntry } from "../lib/dispute-view.ts";

const DETAIL_KEYS = new Set([
  "kind",
  "code",
  "check",
  "ok",
  "status",
  "debugId",
  "payloadSha256",
  "outcome",
  "attempt",
  "verdict",
  "paypalDisputeId",
  "checkVersion",
  "actionKind",
  "dueDate",
  "from",
  "to",
  "outcomeCode",
  "outcomeReason",
  "sandbox_decision",
  "scenarioId",
  "actionId",
  "reason",
]);
const MAX_LEN = 120;

/** A free-text `reason` (the drafting failure's) is model-adjacent: only a short code-like value passes. */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;

type Scalar = string | number | boolean | null;

function scalar(key: string, v: unknown): Scalar | undefined {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  if (key === "reason" && !CODE_LIKE.test(v)) return undefined;
  return v.length > MAX_LEN ? `${v.slice(0, MAX_LEN)}…` : v;
}

export function safeDetail(detail: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(k)) continue;
    const s = scalar(k, v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function auditEntry(r: AuditPageRow): AuditEntry {
  const d = r.detail;
  const sha = str(d["payloadSha256"]);
  return {
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    sandbox: d["sandbox_decision"] === true,
    action: r.action,
    // the proposal's kind names the action ("reply with evidence") on rows that don't carry it themselves
    detail: { ...(r.actionKind === null ? {} : { actionKind: r.actionKind }), ...safeDetail(d) },
    refs: {
      disputeId: r.paypalDisputeId ?? str(d["paypalDisputeId"]),
      debugId: str(d["debugId"]),
      fingerprint: sha === null ? null : sha.slice(0, 8),
      actionId: str(d["actionId"]),
    },
  };
}
