"use client";
// Sign out (BL-01 6629801956, sweep M4): a secondary text button in the dashboard footer, beside the
// audit-log link. POST /api/auth/sign-out (idempotency key), then a full load of the landing page so no
// client cache of the workspace survives. A 401 means the session had already ended: same outcome.
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { newKey, postJson } from "../lib/api.ts";

export function SignOutButton() {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    setFailed(false);
    const res = await postJson("/api/auth/sign-out", {}, newKey());
    if (res.status === 200 || res.status === 401) {
      window.location.assign(`/${locale}`);
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void signOut()}
        className="inline-flex min-h-11 items-center text-accent underline underline-offset-2 disabled:opacity-70"
        data-testid="sign-out"
      >
        {t("signOut")}
      </button>
      {failed ? (
        <span role="alert" className="basis-full text-danger" data-testid="sign-out-error">
          {t("signOutError")}
        </span>
      ) : null}
    </>
  );
}
