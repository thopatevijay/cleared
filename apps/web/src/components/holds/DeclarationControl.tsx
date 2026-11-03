"use client";
// "What did you sell?" (BL-01 6570499264, owner decision option A; hold.md "Seller's declaration"). PayPal
// doesn't say whether a held payment was goods or a service, so the seller says it. It is always shown as
// the seller's own answer ("You marked this as goods"), never as PayPal's classification, and it only picks
// the guided action below it. On a hold PayPal didn't type goods/service, the estimate stays PayPal's: the
// note says so. Changeable until an action is approved; then locked (server-checked).
import { DECLARED_KINDS, type DeclaredKind, type HoldDetail } from "@cleared/core";
import { CircleX, Info, Loader2, Lock, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { useOnline } from "../../lib/use-online.ts";
import { refusalOf } from "../disputes/text.ts";

const primary =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-on-accent disabled:opacity-70 md:w-auto";
const textButton =
  "inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2 disabled:opacity-70";

/** "You marked this as goods" + the note that PayPal's estimate stands (when PayPal didn't type it). */
export function DeclaredLine({ kind, compact = false }: { kind: DeclaredKind; compact?: boolean }) {
  const t = useTranslations("holds.declaration");
  return (
    <p
      className={`flex items-start gap-2 ${compact ? "text-sm" : "font-medium"}`}
      data-testid="declared-line"
      data-kind={kind}
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <UserRound aria-hidden="true" size={16} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span>{t(`marked.${kind}`)}</span>
    </p>
  );
}

function Form({
  holdId,
  current,
  onSaved,
  onCancel,
}: {
  holdId: string;
  current: DeclaredKind | null;
  onSaved: (kind: DeclaredKind) => void;
  onCancel: (() => void) | null;
}) {
  const t = useTranslations("holds.declaration");
  const online = useOnline();
  const id = useId();
  const [kind, setKind] = useState<DeclaredKind | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; ref: string } | null>(null);
  const key = useRef<string | null>(null);
  async function submit(): Promise<void> {
    if (kind === null) {
      setError({ text: t("error.pick"), ref: "" });
      return;
    }
    key.current ??= newKey();
    const sentKey = key.current;
    setBusy(true);
    const res = await postJson(`/api/holds/${holdId}/declaration`, { kind }, sentKey);
    setBusy(false);
    key.current = null;
    if (res.status === 200) {
      setError(null);
      onSaved(kind);
      return;
    }
    const code = res.status === NETWORK_ERROR ? null : refusalOf(res.body);
    setError({
      text:
        code === null
          ? t("error.save")
          : code === "DECLARATION_LOCKED"
            ? t("error.locked", { code })
            : t("error.refused", { code }),
      ref: res.correlationId ?? sentKey,
    });
  }
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="declaration-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint`} disabled={busy}>
        <legend className="mb-1 font-medium">{t("legend")}</legend>
        <div className="flex flex-col gap-2 md:flex-row">
          {DECLARED_KINDS.map((k) => (
            <label
              key={k}
              className="flex min-h-12 flex-1 cursor-pointer items-center gap-3 rounded-md border border-border-strong bg-surface px-3 has-[:checked]:border-2 has-[:checked]:border-accent"
            >
              <input
                type="radio"
                name={`${id}-kind`}
                value={k}
                checked={kind === k}
                className="size-5 accent-accent"
                onChange={() => {
                  setKind(k);
                  setError(null);
                }}
                data-testid={`declare-${k}`}
              />
              <span className="flex flex-col">
                <span className="font-medium">{t(`kind.${k}`)}</span>
                <span className="text-sm text-text-muted">{t(`kindHint.${k}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p id={`${id}-hint`} className="text-sm text-text-muted">
        {t("hint")}
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <button
          type="submit"
          className={primary}
          disabled={busy || !online}
          aria-busy={busy || undefined}
          aria-describedby={online ? undefined : `${id}-off`}
          data-testid="declare-save"
        >
          {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
          {busy ? t("saving") : t("save")}
        </button>
        {onCancel === null ? null : (
          <button type="button" className={textButton} onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
        )}
      </div>
      {online ? null : (
        <p id={`${id}-off`} className="text-sm text-text-muted">
          {t("offline")}
        </p>
      )}
      {error === null || !online ? null : (
        <div role="alert" className="flex flex-col gap-1 text-status-error-fg" data-testid="declare-error">
          <p className="flex items-start gap-2">
            <CircleX aria-hidden="true" size={16} strokeWidth={1.75} className="mt-1 shrink-0" />
            <span>{error.text}</span>
          </p>
          {error.ref === "" ? null : (
            <p className="text-sm text-text-muted">
              {t("reference")}{" "}
              <code lang="en" className="font-mono select-all">
                {error.ref}
              </code>
            </p>
          )}
        </div>
      )}
    </form>
  );
}

/**
 * On a declared-goods hold whose PayPal rule says "don't ship yet" (a payment review): when tracking fits in.
 */
export function ShipFirst() {
  const t = useTranslations("holds.declaration");
  return (
    <p className="flex items-start gap-2 text-sm" data-testid="ship-first">
      <span className="flex h-[1lh] shrink-0 items-center">
        <Info aria-hidden="true" size={16} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span>{t("shipFirst")}</span>
    </p>
  );
}

/** The seller's declaration in the hold detail's action slot (only where PayPal didn't type the hold). */
export function DeclarationControl({ d, onChanged }: { d: HoldDetail; onChanged: () => void }) {
  const t = useTranslations("holds.declaration");
  const decl = d.hold.declaration;
  const [editing, setEditing] = useState(false);
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  if (decl === undefined || !decl.declarable) return null;
  const kind = decl.kind;
  const showForm = kind === null || (editing && !decl.locked);
  return (
    <section
      aria-labelledby="declaration-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      data-testid="declaration"
      data-kind={kind ?? "none"}
      data-locked={decl.locked ? "yes" : "no"}
    >
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <h3 id="declaration-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        {t("title")}
      </h3>
      {kind === null ? null : (
        <div className="flex flex-col gap-1">
          <DeclaredLine kind={kind} />
          <p className="text-sm text-text-muted" data-testid="declared-note">
            {t(`notPayPal.${kind}`)}
          </p>
          {decl.locked ? (
            <p className="flex items-start gap-2 text-sm text-text-muted" data-testid="declaration-locked">
              <span className="flex h-[1lh] shrink-0 items-center">
                <Lock aria-hidden="true" size={14} strokeWidth={1.75} />
              </span>
              <span>{d.hold.completed?.confirmedAt == null ? t("locked") : t("lockedCompleted")}</span>
            </p>
          ) : showForm ? null : (
            <button
              type="button"
              className={textButton}
              aria-label={t("changeName")}
              onClick={() => {
                setEditing(true);
              }}
              data-testid="declaration-change"
            >
              {t("change")}
            </button>
          )}
        </div>
      )}
      {showForm ? (
        <Form
          holdId={d.hold.id}
          current={kind}
          onCancel={
            kind === null
              ? null
              : () => {
                  setEditing(false);
                }
          }
          onSaved={(k) => {
            setEditing(false);
            setAnnounce(t(`saved.${k}`));
            headingRef.current?.focus();
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
