"use client";
// Magic-link sign-in (landing.md): label + email input + "Email me a sign-in link". 200 (always the same,
// whether or not the email exists) → "Check your email" with focus on its heading, and "Send again"
// after a 60 s countdown. Field errors are linked with aria-describedby; 429 shows Retry-After.
import { CircleX, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { minutesFrom, newKey, postJson } from "../lib/api.ts";
import { useOnline } from "../lib/use-online.ts";
import { ErrorPanel } from "./ErrorPanel.tsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_S = 60;
const btn =
  "inline-flex min-h-12 w-full items-center justify-center rounded-md border border-border-strong bg-surface px-4 font-medium text-accent hover:bg-surface-sunken disabled:bg-surface-sunken disabled:text-text-muted md:w-auto";

type Problem =
  | { kind: "field" }
  | { kind: "rate"; minutes: number; ref: string | null }
  | { kind: "error"; ref: string | null };

function CheckEmail({
  email,
  onReset,
  onResend,
}: {
  email: string;
  onReset: () => void;
  onResend: () => void;
}) {
  const t = useTranslations("landing");
  const heading = useRef<HTMLHeadingElement>(null);
  const [left, setLeft] = useState(RESEND_S);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => {
      setLeft(left - 1);
    }, 1000);
    return () => {
      clearTimeout(id);
    };
  }, [left]);
  return (
    <section className="flex flex-col gap-3" data-testid="check-email">
      <Mail aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {t("checkTitle")}
      </h2>
      <p>{t("checkBody", { email })}</p>
      <div className="flex flex-col gap-2 md:flex-row">
        <button type="button" className={btn} onClick={onReset}>
          {t("differentEmail")}
        </button>
        <button
          type="button"
          className={btn}
          disabled={left > 0}
          onClick={() => {
            setLeft(RESEND_S);
            onResend();
          }}
        >
          {left > 0 ? t("sendAgainIn", { seconds: left }) : t("sendAgain")}
        </button>
      </div>
    </section>
  );
}

export function SignInForm() {
  const t = useTranslations("landing");
  const online = useOnline();
  const inputId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function send(address: string): Promise<void> {
    if (!EMAIL_RE.test(address)) {
      setProblem({ kind: "field" });
      return;
    }
    setBusy(true);
    setProblem(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await postJson("/api/auth/magic-link", { email: address, timezone }, newKey());
    setBusy(false);
    if (res.status === 200) setSentTo(address);
    else if (res.status === 400) setProblem({ kind: "field" });
    else if (res.status === 429)
      setProblem({ kind: "rate", minutes: minutesFrom(res.retryAfter), ref: res.correlationId });
    else setProblem({ kind: "error", ref: res.correlationId });
  }

  if (sentTo !== null) {
    return (
      <CheckEmail
        email={sentTo}
        onReset={() => {
          setSentTo(null);
        }}
        onResend={() => void send(sentTo)}
      />
    );
  }
  const fieldError = problem?.kind === "field";
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e: SyntheticEvent) => {
        e.preventDefault();
        void send(email.trim());
      }}
    >
      <label htmlFor={inputId} className="font-medium">
        {t("emailLabel")}
      </label>
      <input
        id={inputId}
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        disabled={busy}
        aria-invalid={fieldError || undefined}
        aria-describedby={fieldError ? errorId : undefined}
        onChange={(e) => {
          setEmail(e.target.value);
        }}
        className="min-h-12 w-full rounded-md border border-border-strong bg-surface px-3 text-base text-text"
      />
      {fieldError ? (
        <p id={errorId} role="alert" className="flex items-center gap-2 text-sm text-danger">
          <CircleX aria-hidden="true" size={16} strokeWidth={1.75} />
          {t("invalidEmail")}
        </p>
      ) : null}
      <button type="submit" className={btn} disabled={busy || !online} aria-busy={busy || undefined}>
        {busy ? t("sending") : t("signinCta")}
      </button>
      {problem?.kind === "rate" ? (
        <ErrorPanel title={t("tooMany", { minutes: problem.minutes })} reference={problem.ref} />
      ) : null}
      {problem?.kind === "error" ? <ErrorPanel title={t("error")} reference={problem.ref} /> : null}
    </form>
  );
}
