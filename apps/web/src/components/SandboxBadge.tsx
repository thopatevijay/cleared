// The Sandbox pill (components.md "Sandbox badge"): inside every sandbox-only control. Hidden from
// assistive tech when the control's own name already ends with "(sandbox only)".
import { FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";

export function SandboxBadge({ decorative = false }: { decorative?: boolean }) {
  const t = useTranslations("common");
  return (
    <span
      aria-hidden={decorative || undefined}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pill bg-status-sandbox-bg px-2 text-xs font-medium text-status-sandbox-fg"
    >
      <FlaskConical aria-hidden="true" size={14} strokeWidth={1.75} />
      {t("sandbox")}
    </span>
  );
}
