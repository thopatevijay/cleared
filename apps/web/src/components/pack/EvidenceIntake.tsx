"use client";
// Evidence intake (payment-detail.md §5): a file (jpg/png/gif/pdf, < 10 MB, pre-checked here; the server
// decides) and/or pasted text, with a kind selector, sent to M2-01's routes with an Idempotency-Key. At
// 375 px the panel sits behind "Add evidence"; from 768 px it is open, with a drop zone. Offline, it is
// disabled. Server refusals show their typed code as a localised message; nothing is added then.
import { INTAKE_KINDS, type SellerEvidenceKind } from "@cleared/core";
import { CircleCheck, CircleX, FilePlus, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { errorCode, newKey, postForm, postJson } from "../../lib/api.ts";
import { useOnline } from "../../lib/use-online.ts";
import { formatBytes, intakeError, preCheck, type IntakeErrorCode } from "./intake-checks.ts";

interface Failure {
  readonly code: IntakeErrorCode | "nothing";
  readonly size?: number;
}

type Outcome = { ok: true } | { ok: false; failure: Failure };

async function send(
  packId: string,
  kind: SellerEvidenceKind,
  file: File | null,
  text: string,
): Promise<Outcome> {
  if (file !== null) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file);
    const r = await postForm(`/api/packs/${packId}/evidence/upload`, form, newKey());
    if (r.status !== 201)
      return { ok: false, failure: { code: intakeError(r.status, errorCode(r.body)), size: file.size } };
  }
  if (text.trim() !== "") {
    const r = await postJson(`/api/packs/${packId}/evidence/text`, { kind, text }, newKey());
    if (r.status !== 201) return { ok: false, failure: { code: intakeError(r.status, errorCode(r.body)) } };
  }
  return { ok: true };
}

export function EvidenceIntake({
  packId,
  onAdded,
  focusOnMount,
}: {
  packId: string;
  onAdded: () => void;
  focusOnMount: boolean;
}) {
  const t = useTranslations("pack");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const online = useOnline();
  const ids = { file: useId(), hint: useId(), kind: useId(), text: useId(), textHint: useId(), err: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [opened, setOpen] = useState(focusOnMount);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<SellerEvidenceKind>("communication");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [added, setAdded] = useState(false);
  // hydrated: the file input's change handler is attached (tests wait for it before choosing a file)
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  const choose = (f: File | null) => {
    setAdded(false);
    const code = f === null ? null : preCheck(f);
    setFailure(code === null ? null : { code, size: f?.size ?? 0 });
    setFile(code === null ? f : null);
    if (code !== null && fileInput.current !== null) fileInput.current.value = "";
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setAdded(false);
    if (file === null && text.trim() === "") {
      setFailure({ code: "nothing" });
      return;
    }
    setBusy(true);
    const out = await send(packId, kind, file, text);
    setBusy(false);
    if (!out.ok) {
      setFailure(out.failure);
      return;
    }
    setFailure(null);
    setFile(null);
    setText("");
    if (fileInput.current !== null) fileInput.current.value = "";
    setAdded(true);
    onAdded();
  };

  const message =
    failure === null
      ? null
      : failure.code === "nothing"
        ? t("intake.nothing")
        : t(`errors.${failure.code}`, { size: formatBytes(locale, failure.size ?? 0) });
  const disabled = busy || !online;
  // a chosen file, an error or offline keep the panel open at 375 px, so the field state is visible
  const shown = opened || file !== null || failure !== null || !online;

  return (
    <section
      aria-labelledby="intake-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      data-testid="intake"
      data-ready={ready}
      id="intake"
    >
      <button
        id="intake-open"
        type="button"
        className={`${shown ? "hidden" : "flex"} min-h-12 w-full items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 font-medium md:hidden`}
        aria-expanded={shown}
        aria-controls="intake-form"
        onClick={() => {
          setOpen(true);
          window.setTimeout(() => heading.current?.focus(), 0);
        }}
        data-testid="intake-open"
      >
        <FilePlus aria-hidden="true" size={20} strokeWidth={1.75} />
        {t("intake.open")}
      </button>
      <form
        id="intake-form"
        className={`${shown ? "flex" : "hidden md:flex"} flex-col gap-4`}
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <h3 id="intake-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {t("intake.heading")}
        </h3>
        {!online ? (
          <p role="status" className="text-status-info-fg">
            {t("intake.offline")}
          </p>
        ) : null}
        <div
          className="flex flex-col gap-2 md:rounded-md md:border md:border-dashed md:border-border-strong md:p-4"
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files.item(0));
          }}
        >
          <p className="hidden text-sm text-text-muted md:block">{t("intake.drop")}</p>
          <label
            htmlFor={ids.file}
            className={`inline-flex min-h-11 cursor-pointer items-center gap-2 self-start rounded-md border border-border-strong px-4 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus ${disabled ? "opacity-60" : ""}`}
          >
            <Upload aria-hidden="true" size={18} strokeWidth={1.75} />
            {t("intake.file")}
            <input
              ref={fileInput}
              id={ids.file}
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.pdf,image/jpeg,image/png,image/gif,application/pdf"
              className="sr-only"
              aria-describedby={`${ids.hint} ${ids.err}`}
              disabled={disabled}
              data-testid="intake-file"
              onChange={(e) => {
                choose(e.target.files?.item(0) ?? null);
              }}
            />
          </label>
          <p id={ids.hint} className="text-sm text-text-muted">
            {file === null
              ? t("intake.fileHint")
              : t("intake.fileChosen", { name: file.name, size: formatBytes(locale, file.size) })}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.kind} className="font-medium">
            {t("intake.kind")}
          </label>
          <select
            id={ids.kind}
            value={kind}
            disabled={disabled}
            onChange={(e) => {
              setKind(e.target.value as SellerEvidenceKind);
            }}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-3"
            data-testid="intake-kind"
          >
            {INTAKE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kindOption.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.text} className="font-medium">
            {t("intake.paste")}
          </label>
          <p id={ids.textHint} className="text-sm text-text-muted">
            {t("intake.pasteHint")}
          </p>
          <textarea
            id={ids.text}
            rows={6}
            value={text}
            disabled={disabled}
            aria-describedby={`${ids.textHint} ${ids.err}`}
            onChange={(e) => {
              setText(e.target.value);
            }}
            className="rounded-md border border-border-strong bg-surface p-3"
            data-testid="intake-text"
          />
        </div>
        <p id={ids.err} role="alert" className="text-status-error-fg empty:hidden" data-testid="intake-error">
          {message === null ? null : (
            <span className="inline-flex items-start gap-1">
              <CircleX aria-hidden="true" size={16} strokeWidth={1.75} className="mt-1 shrink-0" />
              {message}
            </span>
          )}
        </p>
        <p role="status" className="text-status-completed-fg empty:hidden" data-testid="intake-added">
          {added ? (
            <span className="inline-flex items-center gap-1">
              <CircleCheck aria-hidden="true" size={16} strokeWidth={1.75} />
              {t("intake.added")}
            </span>
          ) : null}
        </p>
        <button
          type="submit"
          disabled={disabled}
          className="min-h-11 self-start rounded-md bg-accent px-6 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
          data-testid="intake-add"
        >
          {busy ? t("intake.adding") : t("intake.add")}
        </button>
      </form>
    </section>
  );
}
