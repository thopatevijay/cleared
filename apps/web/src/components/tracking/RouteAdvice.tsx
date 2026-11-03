"use client";
// Route advice (M3-03; dashboard.md elements 10–11, hold.md action slot). Tier badges are icon + label in
// status colours (approved: completed + truck; accepted: held + triangle-alert; other: neutral +
// circle-help), so they read in greyscale. Every tier shows its source and the sandbox caveat. The copy
// never brands a carrier as unapproved: an accepted carrier is one PayPal takes that may not speed up
// the release (PayPal decides the release). `releaseClaims={false}` (a hold the seller declared goods, which
// PayPal didn't type goods, e.g. a payment review) swaps every release-speed phrase for neutral copy
// (`holds.tracking.neutral.*`): the delivery-based release rule doesn't apply there (ADR 0017 addendum 3).
import type { TrackingSummary } from "@cleared/core";
import { CircleHelp, ExternalLink, TriangleAlert, Truck, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

type Tier = "approved" | "accepted" | "other";
type Sources = TrackingSummary["sources"];
type TierSourceView = Sources["approved"];

const TIER: Record<Tier, { icon: LucideIcon; pill: string }> = {
  approved: { icon: Truck, pill: "bg-status-completed-bg text-status-completed-fg" },
  accepted: { icon: TriangleAlert, pill: "bg-status-held-bg text-status-held-fg" },
  other: { icon: CircleHelp, pill: "bg-status-neutral-bg text-status-neutral-fg" },
};

export function TierBadge({ tier }: { tier: Tier }) {
  const t = useTranslations("holds.tracking");
  const { icon: Icon, pill } = TIER[tier];
  return (
    <span
      className={`inline-flex min-h-6 items-center gap-1 rounded-pill px-2 text-sm font-medium ${pill}`}
      data-testid="tier-badge"
      data-tier={tier}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
      {t(`tierLabel.${tier}`)}
    </span>
  );
}

/** "Source" disclosure for a carrier list: title, date, link (the dropdown has none) and note. */
export function TierSource({ source, label }: { source: TierSourceView; label: string }) {
  const t = useTranslations("holds.tracking");
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="inline-flex flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        aria-expanded={open}
        aria-controls={id}
        data-testid="tier-source-toggle"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label}
      </button>
      <span
        id={id}
        hidden={!open}
        className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3 text-sm text-text"
        data-testid="tier-source-panel"
      >
        <span className="font-medium">{source.title}</span>
        {source.note ? <span className="text-text-muted">{source.note}</span> : null}
        <span className="text-text-muted">{t("sourceDate", { date: source.date })}</span>
        {source.url === null ? (
          <span className="text-text-muted">{t("sourceNoLink")}</span>
        ) : (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center gap-1 self-start break-all text-accent underline underline-offset-2"
          >
            {t("sourceOpen")}
            <ExternalLink aria-hidden="true" size={14} strokeWidth={1.75} />
          </a>
        )}
      </span>
    </span>
  );
}

function Caveat() {
  const t = useTranslations("holds.tracking");
  return (
    <p className="text-sm text-text-muted" data-testid="carrier-caveat">
      {t("caveat")}
    </p>
  );
}

function SourcesRow({ sources }: { sources: Sources }) {
  const t = useTranslations("holds.tracking");
  return (
    <span className="flex flex-wrap gap-x-4">
      <TierSource source={sources.accepted} label={t("sourceAccepted")} />
      <TierSource source={sources.approved} label={t("sourceApproved")} />
    </span>
  );
}

const names = (s: TrackingSummary, max: number) =>
  s.alternatives
    .slice(0, max)
    .map((a) => a.name)
    .join(", ");

/**
 * The dashboard row's advice line (element 11). A flagged carrier: "India Post: PayPal accepts it; it may
 * not speed up the release. Faster: …" + Sources + caveat. No carrier yet: the prevention nudge. An
 * approved carrier: nothing (no warning).
 */
export function RouteAdviceLine({
  s,
  releaseClaims = true,
}: {
  s: TrackingSummary;
  releaseClaims?: boolean;
}) {
  const t = useTranslations("holds.tracking");
  const n = releaseClaims ? "" : "neutral.";
  if (s.state === "filed" || (s.chosen !== null && !s.flagged)) return null;
  if (s.chosen === null && s.alternatives.length === 0) return null;
  const flagged = s.chosen !== null;
  const Icon = flagged ? TriangleAlert : Truck;
  return (
    <div
      className="flex flex-col items-start gap-1 text-sm"
      data-testid="route-advice"
      data-flagged={flagged}
    >
      <p className="flex items-start gap-2">
        <span className="flex h-[1lh] shrink-0 items-center">
          <Icon
            aria-hidden="true"
            size={16}
            strokeWidth={1.75}
            className={flagged ? "text-status-held-fg" : "text-text-muted"}
          />
        </span>
        <span>
          {s.chosen === null ? (
            t(`${n}nudge`, { carriers: names(s, 4) })
          ) : (
            <>
              <span className="font-medium">
                {t(`${n}${s.chosen.tier === "other" ? "adviceOther" : "advice"}`, { carrier: s.chosen.name })}
              </span>
              {s.alternatives.length > 0 ? <> {t(`${n}faster`, { carriers: names(s, 4) })}</> : null}
            </>
          )}
        </span>
      </p>
      <SourcesRow sources={s.sources} />
      <Caveat />
    </div>
  );
}

/** The detail page's route advice (hold.md action slot): the chosen carrier's tier and the alternatives. */
export function RouteAdvice({ s, releaseClaims = true }: { s: TrackingSummary; releaseClaims?: boolean }) {
  const t = useTranslations("holds.tracking");
  const n = releaseClaims ? "" : "neutral.";
  const headingId = useId();
  if (s.state === "filed") return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid="route-advice-full">
      <h3 id={headingId} className="text-lg font-semibold">
        {t("adviceTitle")}
      </h3>
      {s.chosen === null ? null : (
        <div className="flex flex-col items-start gap-1">
          <p className="text-sm text-text-muted">{t("chosen")}</p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.chosen.name}</span>
            <code lang="en" className="font-mono text-xs text-text-muted">
              {s.chosen.code}
            </code>
            <TierBadge tier={s.chosen.tier} />
          </p>
          <p className="text-sm">{t(`${n}tier.${s.chosen.tier}`)}</p>
        </div>
      )}
      {s.alternatives.length === 0 || (s.chosen !== null && !s.flagged) ? null : (
        <>
          <p className="font-medium">{t(`${n}alternatives`)}</p>
          <ul className="grid grid-cols-1 gap-1 md:grid-cols-2" data-testid="alternatives">
            {s.alternatives.slice(0, 8).map((a) => (
              <li
                key={a.code}
                className="flex min-h-12 flex-wrap items-center gap-x-2 rounded-md border border-border px-3 py-2"
              >
                <span>{a.name}</span>
                <code lang="en" className="font-mono text-xs text-text-muted">
                  {a.code}
                </code>
              </li>
            ))}
          </ul>
        </>
      )}
      <SourcesRow sources={s.sources} />
      <Caveat />
    </section>
  );
}
