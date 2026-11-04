"use client";
// Draft reply review = the ApprovalCard (dispute-review.md §2, components.md): exactly what goes to PayPal
// (action, notes with a live "n / 2000" count, evidence type + why, the selected items, the compiled PDF),
// the draft fingerprint the approval is bound to, the deadline, and Approve after all of it. Edits call
// draft/revise 800 ms after the last change (or on blur); Approve stays disabled while an edit is pending,
// over the limit, with no item, when PayPal's links don't offer the action, too late, or kill switch on.
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { codePointCount, NOTES_MAX } from "../../lib/dispute-helpers.ts";
import type { DisputeDetail, Draft } from "../../lib/dispute-view.ts";
import { formatBytes, formatTime, formatUtc } from "../../lib/format.ts";
import { AcceptClaimDialog } from "./AcceptClaimDialog.tsx";
import { ApproveDialog } from "./ApproveDialog.tsx";
import { EvidenceItems, Fingerprint, NotesField } from "./DraftParts.tsx";
import { ScopeGapWarning } from "./ScopeGapWarning.tsx";
import { useDisputeText, useUiLocale } from "./text.ts";
import { useRevise, type Refresh } from "./useRevise.ts";

const REVISE_DEBOUNCE_MS = 800;
const OLD_FINGERPRINT_MS = 5_000;

type Blocker = "over" | "empty" | "updating" | "killSwitch" | "notAllowed" | "tooLate" | "error";

function useLocalDraft(draft: Draft) {
  const actionId = draft.action?.id ?? null;
  const [notes, setNotes] = useState(draft.notes);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(draft.items.filter((i) => i.selected).map((i) => i.id)),
  );
  const [dirty, setDirty] = useState(false);
  const base = useRef(actionId);
  useEffect(() => {
    if (base.current === actionId || dirty) return;
    base.current = actionId;
    setNotes(draft.notes);
    setSelected(new Set(draft.items.filter((i) => i.selected).map((i) => i.id)));
  }, [actionId, dirty, draft]);
  return { notes, setNotes, selected, setSelected, dirty, setDirty };
}

export function DraftReview({
  detail,
  onChanged,
  onDialog,
}: {
  detail: DisputeDetail & { draft: Draft };
  onChanged: Refresh;
  /** pauses polling while a dialog is open, so the confirmed draft never changes under it */
  onDialog: (open: boolean) => void;
}) {
  const t = useTranslations("disputes.draft");
  const ta = useTranslations("disputes.accept");
  const text = useDisputeText();
  const locale = useUiLocale();
  const { draft, dispute: d } = detail;
  const action = draft.action;
  const tz = detail.workspace.timezone;
  const local = useLocalDraft(draft);
  const { revise, busy, error } = useRevise(d.id, draft.id, onChanged);
  const [previous, setPrevious] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const tooLate = d.deadlineState === "closed_for_action";
  // a failed filing stays editable: an edit (or "Review and approve again") makes a new proposal
  const state = action?.state ?? null;
  const readOnly = (state !== "proposed" && state !== "failed") || tooLate || !draft.allowed;
  const sentOrSending =
    state === "approved" || state === "executing" || state === "unknown" || state === "succeeded";
  const over = codePointCount(local.notes) > NOTES_MAX;

  async function commit(): Promise<void> {
    if (!local.dirty || over || local.selected.size === 0 || local.notes.trim() === "") return;
    const before = action?.payload_sha256.slice(0, 8) ?? null;
    if (await revise({ notes: local.notes, itemIds: [...local.selected] })) {
      local.setDirty(false);
      setRefusal(null);
      setPrevious(before);
    }
  }
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!local.dirty) return undefined;
    const id = setTimeout(() => void commitRef.current(), REVISE_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
    };
  }, [local.dirty, local.notes, local.selected]);
  useEffect(() => {
    if (previous === null) return undefined;
    const id = setTimeout(() => {
      setPrevious(null);
    }, OLD_FINGERPRINT_MS);
    return () => {
      clearTimeout(id);
    };
  }, [previous]);

  const blocker: Blocker | null = tooLate
    ? "tooLate"
    : detail.killSwitch
      ? "killSwitch"
      : !draft.allowed
        ? "notAllowed"
        : over
          ? "over"
          : local.selected.size === 0
            ? "empty"
            : local.dirty || busy
              ? "updating"
              : error !== null
                ? "error"
                : null;
  const amount = d.amount ?? d.payment?.amount ?? null;
  const amountText = amount === null ? "" : `${amount.value} ${amount.currency}`;
  return (
    <section
      id="approval"
      tabIndex={-1}
      aria-labelledby="approval-heading"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 focus-visible:outline-2"
      data-testid="approval-card"
    >
      {detail.killSwitch ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-status-held-bg p-3 text-status-held-fg"
          data-testid="kill-banner"
        >
          <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          {t("killBanner")}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <h2 id="approval-heading" className="text-xl font-semibold">
          {state === "succeeded" ? t("headingFiled") : t("heading")}{" "}
          <code className="font-mono text-sm font-normal break-all">{d.disputeId}</code>
        </h2>
        <p className="text-sm text-text-muted">
          {sentOrSending ? t("approvedSub") : action?.createdBy === "seller" ? t("seller") : t("agent")}
        </p>
      </div>
      {readOnly ? null : (
        <ScopeGapWarning gaps={draft.gaps} edited={action?.createdBy === "seller"} />
      )}
      <h3 className="font-semibold">{t("receives")}</h3>
      <dl className="flex flex-col gap-3">
        <div>
          <dt className="text-sm text-text-muted">{t("action")}</dt>
          <dd>
            {text.kind(draft.actionKind)}{" "}
            <code className="font-mono text-xs text-text-muted">{draft.actionKind}</code>
          </dd>
        </div>
        {draft.evidenceType === null ? null : (
          <div>
            <dt className="text-sm text-text-muted">{t("evidenceType")}</dt>
            <dd>
              <code className="font-mono text-sm">{draft.evidenceType}</code>
              <span className="block text-sm">
                {t("why")}
                {":"}{" "}
                {draft.reasonUnmapped || d.reason === null || !t.has(`explain.${d.reason}`)
                  ? t("explain.unmapped")
                  : t(`explain.${d.reason}`)}
              </span>
            </dd>
          </div>
        )}
      </dl>
      <NotesField
        value={local.notes}
        readOnly={readOnly}
        onChange={(v) => {
          local.setNotes(v);
          local.setDirty(true);
        }}
        onBlur={() => void commit()}
      />
      <EvidenceItems
        items={draft.items}
        selected={local.selected}
        readOnly={readOnly}
        timeZone={tz}
        onToggle={(id) => {
          const next = new Set(local.selected);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          local.setSelected(next);
          local.setDirty(true);
        }}
      />
      <p className="flex flex-wrap items-center gap-x-3" data-testid="pdf">
        {draft.pdf === null ? (
          <span className="text-text-muted">{t("pdfNone")}</span>
        ) : (
          <>
            <span>{t("pdf", { size: formatBytes(locale, draft.pdf.bytes) })}</span>
            <a
              href={draft.pdf.url}
              download
              className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              {t("pdfDownload")}
            </a>
          </>
        )}
      </p>
      {action === null ? null : <Fingerprint sha={action.payload_sha256} previous={previous} />}
      {d.dueDate === null ? null : (
        <p className="text-sm" title={formatUtc(d.dueDate, locale)}>
          {t("deadline", { date: formatTime(locale, d.dueDate, tz) })}
        </p>
      )}
      <p aria-live="polite" className="text-sm text-text-muted" data-testid="revise-status">
        {busy
          ? t("updating")
          : previous !== null && action !== null
            ? t("updated", { fp: action.payload_sha256.slice(0, 8) })
            : ""}
      </p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {t("reviseError", { message: text.refusal(error) })}
        </p>
      )}
      {refusal === null ? null : (
        <p
          role="alert"
          className="rounded-md bg-status-error-bg p-3 text-status-error-fg"
          data-testid="approve-refusal"
        >
          {text.refusal(refusal)}
        </p>
      )}
      {readOnly || state === "failed" ? (
        <p className="text-text-muted" data-testid="approve-unavailable">
          {tooLate
            ? t("tooLate")
            : !draft.allowed
              ? t("notAllowed")
              : state === "failed"
                ? t("failedHint")
                : t("readOnly")}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={blocker !== null}
            aria-describedby={blocker === null ? undefined : "approve-blocker"}
            onClick={() => {
              setRefusal(null);
              setApproving(true);
              onDialog(true);
            }}
            className="min-h-12 w-full rounded-md bg-accent px-5 font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-sunken disabled:text-text-muted md:w-auto md:self-start"
            data-testid="approve"
          >
            {t("approve")}
          </button>
          {blocker === null ? null : (
            <p id="approve-blocker" className="text-sm text-text-muted">
              {t(`approveDisabled.${blocker}`)}
            </p>
          )}
        </div>
      )}
      {action === null ? null : (
        <ApproveDialog
          open={approving}
          disputeId={d.id}
          actionId={action.id}
          reviewedSha={action.payload_sha256}
          onClose={() => {
            setApproving(false);
            onDialog(false);
          }}
          onApproved={() => void onChanged()}
          onRefused={(code) => {
            setRefusal(code);
            void onChanged();
          }}
        />
      )}
      {d.status === "RESOLVED" || tooLate ? null : (
        <details className="border-t border-border pt-3">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{ta("other")}</summary>
          <AcceptClaimDialog
            disputeRowId={d.id}
            expected={d.amount === null ? null : amountText}
            amountText={amountText}
            allowed={d.allowedActions.includes("accept_claim") && detail.acceptClaim?.state !== "approved"}
            onDone={() => void onChanged()}
          />
        </details>
      )}
    </section>
  );
}
