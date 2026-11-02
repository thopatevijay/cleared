// HI notification copy (docs/design/screens/notifications.md; review and formatting: M4-03).
import type { NotificationKind } from "../rules.ts";
import type { TemplateStrings, SentenceParams } from "./types.ts";

function span(p: SentenceParams): string {
  if (p.remaining === null) return "";
  return p.remaining.unit === "days" ? `${String(p.remaining.n)} दिन` : `${String(p.remaining.n)} घंटे`;
}

function when(p: SentenceParams): string {
  return p.due === null ? "" : ` (${p.due.date}, ${p.due.time} ${p.due.tz})`;
}

const SENTENCES: Readonly<Record<NotificationKind, (p: SentenceParams) => string>> = {
  hold_opened: (p) => `PayPal ने ${p.amount} रोका है${p.reasonCode === "" ? "" : ` (${p.reasonCode})`}।`,
  dispute_opened: (p) =>
    `एक खरीदार ने ${p.amount} पर विवाद खोला है${p.reason === "" ? "" : `: ${p.reason}`}। जवाब तैयार किया जा रहा है।`,
  deadline_t72: (p) => `${p.amount} वाले विवाद का जवाब ${span(p)} में देना है${when(p)}।`,
  deadline_t24: (p) => `${p.amount} वाले विवाद का जवाब ${span(p)} में देना है${when(p)}।`,
  completed_reminder: (p) =>
    `आपने ऑर्डर को 7 दिन पहले पूरा बताया था। ${p.amount} के जारी होने की अनुमानित तारीख ${p.release?.date ?? "अभी पता नहीं"} है।`,
};

export const HI: TemplateStrings = {
  sentence: (kind, p) => SENTENCES[kind](p),
  open: "Cleared में खोलें",
  footer: "Cleared ने आपके PayPal sandbox खाते के बारे में भेजा। ईमेल में सबूत या खरीदार के संदेश कभी नहीं होते।",
};
