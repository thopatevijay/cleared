// Summary bar facts (sweep M5, BL-01 6604837005 item 8): zero facts are plain text, consistently; a
// non-zero proof-ready count (or an active filter) stays the filter link.
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json" with { type: "json" };
import { SummaryBar } from "./SummaryBar.tsx";

vi.mock("../i18n/navigation.ts", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest} href="#x">
      {children}
    </a>
  ),
}));

const html = (node: ReactNode): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const proofFact = (out: string): string =>
  /<(a|span)[^>]*data-testid="summary-proof-ready"[^>]*>/.exec(out)?.[0] ?? "";

describe("SummaryBar zero facts", () => {
  it("an empty dashboard has no summary links: held, in dispute and proof-ready are plain text", () => {
    const out = html(<SummaryBar held={[]} proofReady={0} filter={null} inDispute={[]} />);
    expect(out).not.toContain("<a ");
    expect(proofFact(out)).toMatch(/^<span/);
    expect(out).toContain("0 payments proof-ready");
  });

  it("a non-zero count, or an active proof-ready filter, keeps the filter link", () => {
    expect(proofFact(html(<SummaryBar held={[]} proofReady={2} filter={null} inDispute={[]} />))).toMatch(/^<a/);
    const active = proofFact(html(<SummaryBar held={[]} proofReady={0} filter="proof-ready" inDispute={[]} />));
    expect(active).toMatch(/^<a/);
    expect(active).toContain('aria-current="true"');
  });
});
