// EN notification copy (docs/design/screens/notifications.md). The buyer's name is not stored (owner,
// 2026-11-02), so the dispute sentence says "A buyer".
import type { NotificationKind } from "../rules.ts";
import type { TemplateStrings, SentenceParams } from "./types.ts";

function due(p: SentenceParams): string {
  if (p.remaining === null || p.due === null) return "";
  const n = p.remaining.n;
  const span =
    p.remaining.unit === "days"
      ? `${String(n)} ${n === 1 ? "day" : "days"}`
      : `${String(n)} ${n === 1 ? "hour" : "hours"}`;
  return `in ${span} (${p.due.date}, ${p.due.time} ${p.due.tz})`;
}

const SENTENCES: Readonly<Record<NotificationKind, (p: SentenceParams) => string>> = {
  hold_opened: (p) => `PayPal is holding ${p.amount}${p.reasonCode === "" ? "" : ` (${p.reasonCode})`}.`,
  dispute_opened: (p) =>
    `A buyer opened a dispute on ${p.amount}${p.reason === "" ? "" : `: ${p.reason}`}. A reply is being drafted.`,
  deadline_t72: (p) => `Reply to the ${p.amount} dispute is due ${due(p)}.`,
  deadline_t24: (p) => `Reply to the ${p.amount} dispute is due ${due(p)}.`,
  completed_reminder: (p) =>
    `7 days since you marked the order Completed. The estimated release for ${p.amount} is ${p.release?.date ?? "not known yet"}.`,
};

export const EN: TemplateStrings = {
  sentence: (kind, p) => SENTENCES[kind](p),
  open: "Open in Cleared",
  footer:
    "Sent by Cleared about your PayPal sandbox account. Evidence and buyer messages are never included in email.",
};
