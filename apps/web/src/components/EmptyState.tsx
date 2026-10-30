// Empty state (components.md): a 32 px outline icon, a one-line heading, one sentence, at most one action.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  body,
  headingLevel = 2,
  children,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  headingLevel?: 2 | 3;
  children?: ReactNode;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
      data-testid="empty-state"
    >
      <Icon aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
      <H className="text-xl font-semibold">{title}</H>
      <p className="max-w-prose text-text-muted">{body}</p>
      {children}
    </section>
  );
}
