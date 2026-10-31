"use client";
// Error (payment-detail.md "States"): "Couldn't load this payment", Retry, and the reference (Next's digest
// of the server error; the request's correlation id is in the server log line that carries it).
import { useTranslations } from "next-intl";
import { ErrorPanel } from "../../../../../src/components/ErrorPanel.tsx";

export default function PackError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("pack");
  return (
    <main id="main" className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6">
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error.digest ?? null}
        onRetry={reset}
      />
    </main>
  );
}
