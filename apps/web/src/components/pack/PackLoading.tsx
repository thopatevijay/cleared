"use client";
// Loading (payment-detail.md "States"): the header skeleton and three verdict skeleton rows; after 3 s,
// "Loading the proof pack…".
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function PackLoading() {
  const t = useTranslations("pack");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setSlow(true);
    }, 3000);
    return () => {
      window.clearTimeout(id);
    };
  }, []);
  return (
    <div aria-busy="true" className="flex flex-col gap-6" data-testid="loading">
      <div aria-hidden="true" className="flex flex-col gap-3">
        <span className="skeleton-pulse block h-8 w-64 max-w-full rounded-md" />
        <span className="skeleton-pulse block h-6 w-40 rounded-md" />
        <span className="skeleton-pulse block h-4 w-56 max-w-full rounded-md" />
      </div>
      <ul aria-hidden="true" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
            <span className="skeleton-pulse block h-5 w-3/4 rounded-md" />
            <span className="skeleton-pulse block h-6 w-24 rounded-md" />
          </li>
        ))}
      </ul>
      <p role="status" className="text-text-muted">
        {slow ? t("loadingSlow") : ""}
      </p>
    </div>
  );
}
