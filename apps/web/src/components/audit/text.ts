// An audit entry in plain words (audit-log.md copy): the action ("Approved reply with evidence"), its result
// ("Completed (200)", "Refused: DEADLINE_PASSED") and its tone. Unknown actions show their code verbatim.
import { useTranslations } from "next-intl";
import type { AuditEntry } from "../../lib/dispute-view.ts";

export type Tone = "ok" | "bad" | "neutral" | "sandbox";

const s = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export function useAuditText() {
  const t = useTranslations("auditLog");
  const what = (e: AuditEntry): string => {
    const k = s(e.detail["kind"]) || s(e.detail["actionKind"]);
    return t.has(`what.${k}`) ? t(`what.${k}`) : t("what.other");
  };
  const check = (c: string): string =>
    t.has(`check.${c}`) ? t(`check.${c}`) : t("check.other", { check: c });
  return {
    actor: (e: AuditEntry): string => t(`actor.${e.sandbox ? "sandbox" : e.actor}`),
    action: (e: AuditEntry): string => {
      const key = e.action.replace(/\./g, "_");
      if (!t.has(`action.${key}`)) return t("action.other", { action: e.action });
      return t(`action.${key}`, { what: what(e), check: check(s(e.detail["check"])) });
    },
    result: (e: AuditEntry): { text: string; tone: Tone } => result(t, e),
  };
}

type T = ReturnType<typeof useTranslations<"auditLog">>;

function result(t: T, e: AuditEntry): { text: string; tone: Tone } {
  const d = e.detail;
  const code = s(d["code"]) || "—";
  switch (e.action) {
    case "action.proposed":
      return { text: t("result.proposed"), tone: "neutral" };
    case "action.approved":
      return { text: t("result.approved"), tone: "ok" };
    case "action.approval_refused":
    case "action.reject_refused":
    case "action.failed":
      return { text: t("result.refused", { code }), tone: "bad" };
    case "action.rejected":
      return {
        text: d["reason"] === "superseded" ? t("result.superseded") : t("result.rejected"),
        tone: "neutral",
      };
    case "action.check":
      return d["ok"] === true
        ? { text: t("result.passed"), tone: "ok" }
        : { text: t("result.refused", { code }), tone: "bad" };
    case "action.sent":
      return d["status"] === null || d["status"] === undefined
        ? { text: t("result.sentNoStatus"), tone: "neutral" }
        : {
            text: t("result.sent", { status: s(d["status"]) }),
            tone: Number(d["status"]) < 300 ? "ok" : "bad",
          };
    case "action.succeeded":
      return { text: t("result.succeeded"), tone: "ok" };
    case "action.unknown":
      return { text: t("result.unknown"), tone: "neutral" };
    case "dispute.status_changed":
      return d["to"] === "RESOLVED" && typeof d["outcomeCode"] === "string"
        ? { text: t("result.resolved", { code: d["outcomeCode"] }), tone: "neutral" }
        : { text: t("result.status", { from: s(d["from"]), to: s(d["to"]) }), tone: "neutral" };
    default:
      return e.sandbox
        ? { text: t("result.sandbox"), tone: "sandbox" }
        : { text: t("result.recorded"), tone: "neutral" };
  }
}
