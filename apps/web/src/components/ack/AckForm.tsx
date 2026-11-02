"use client";
// The client's confirmation form on the public acknowledgement page (client-ack.md, M3-06): typed name,
// "I agree" box, Confirm. Client-side checks first, then POST /api/ack/:token decides. Success replaces
// the form; an unusable link (the server's neutral answer) shows the neutral panel. Every value the user
// or the seller typed renders as plain text.
import { ACK_NAME_MAX_CHARS } from "@cleared/core";
import { CircleCheck, CircleX, Info, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { ErrorPanel } from "../ErrorPanel.tsx";

type Phase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "done"; name: string; at: string }
  | { kind: "neutral" }
  | { kind: "limited" }
  | { kind: "error"; reference: string | null };

type FieldErrors = { name?: "nameRequired" | "nameTooLong"; agree?: "agreeRequired" };

function check(name: string, agree: boolean): FieldErrors {
  const n = name.normalize("NFC").trim();
  return {
    ...(n === ""
      ? { name: "nameRequired" as const }
      : n.length > ACK_NAME_MAX_CHARS
        ? { name: "nameTooLong" as const }
        : {}),
    ...(agree ? {} : { agree: "agreeRequired" as const }),
  };
}

async function submit(token: string, name: string): Promise<Phase> {
  try {
    const res = await fetch(`/api/ack/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, agree: true }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (res.status === 200) {
      const body = (await res.json()) as { acceptedAt: string };
      return { kind: "done", name: name.normalize("NFC").trim(), at: body.acceptedAt };
    }
    if (res.status === 404) return { kind: "neutral" };
    if (res.status === 429) return { kind: "limited" };
    return { kind: "error", reference: res.headers.get("x-correlation-id") };
  } catch {
    return { kind: "error", reference: null };
  }
}

export function NeutralPanel() {
  const t = useTranslations("ack");
  return (
    <section className="flex flex-col items-start gap-3" data-testid="ack-neutral">
      <Lock aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
      <h1 className="text-2xl font-semibold">{t("neutralTitle")}</h1>
      <p>{t("neutralBody")}</p>
    </section>
  );
}

function Success({ name, at }: { name: string; at: string }) {
  const t = useTranslations("ack");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  // The client has no workspace: their own browser's time zone, named.
  const time = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    numberingSystem: "latn",
  }).format(new Date(at));
  return (
    <section
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
      data-testid="ack-success"
    >
      <CircleCheck aria-hidden="true" size={32} strokeWidth={1.75} className="text-status-completed-fg" />
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {t("success", { name })}
      </h2>
      <p>{t("recordedAt", { time })}</p>
      <p className="text-text-muted">{t("successClose")}</p>
    </section>
  );
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="flex items-center gap-1 text-sm text-danger">
      <CircleX aria-hidden="true" size={16} strokeWidth={1.75} />
      {text}
    </p>
  );
}

export function AckForm({ token, seller }: { token: string; seller: string }) {
  const t = useTranslations("ack");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const agreeRef = useRef<HTMLInputElement>(null);

  if (phase.kind === "done") return <Success name={phase.name} at={phase.at} />;
  if (phase.kind === "neutral") return <NeutralPanel />;

  const onSubmit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const found = check(name, agree);
    setErrors(found);
    if (found.name || found.agree) {
      (found.name ? nameRef : agreeRef).current?.focus();
      return;
    }
    setPhase({ kind: "submitting" });
    setPhase(await submit(token, name));
  };
  const busy = phase.kind === "submitting";
  const nameDesc = `ack-name-hint${errors.name ? " ack-name-error" : ""}`;
  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-5" aria-busy={busy}>
      <div className="flex flex-col gap-1">
        <label htmlFor="ack-name" className="font-medium">
          {t("name")}
        </label>
        <p id="ack-name-hint" className="text-sm text-text-muted">
          {t("nameHint")}
        </p>
        <input
          ref={nameRef}
          id="ack-name"
          name="name"
          autoComplete="name"
          maxLength={ACK_NAME_MAX_CHARS}
          value={name}
          readOnly={busy}
          onChange={(e) => {
            setName(e.target.value);
          }}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={nameDesc}
          className={`min-h-12 w-full rounded-md border bg-surface px-3 ${errors.name ? "border-danger" : "border-border-strong"}`}
        />
        {errors.name ? <FieldError id="ack-name-error" text={t(`error.${errors.name}`)} /> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="ack-agree" className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            ref={agreeRef}
            id="ack-agree"
            type="checkbox"
            checked={agree}
            disabled={busy}
            onChange={(e) => {
              setAgree(e.target.checked);
            }}
            aria-invalid={errors.agree ? true : undefined}
            aria-describedby={errors.agree ? "ack-agree-error" : undefined}
            className="size-6 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="font-medium">{t("agree")}</span>
        </label>
        {errors.agree ? <FieldError id="ack-agree-error" text={t(`error.${errors.agree}`)} /> : null}
      </div>
      <p className="flex items-start gap-2 text-sm text-text-muted">
        <Info aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>{t("recorded", { seller })}</span>
      </p>
      {phase.kind === "limited" ? (
        <p role="alert" className="rounded-md bg-status-held-bg p-3 text-status-held-fg">
          {t("rateLimited")}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <ErrorPanel title={t("errorTitle")} body={t("errorBody")} reference={phase.reference} />
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="min-h-12 w-full rounded-md bg-accent px-6 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60 md:w-auto md:self-start"
      >
        {busy ? t("confirming") : t("confirm")}
      </button>
    </form>
  );
}
