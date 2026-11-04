// ErrorPanel Retry (sweep M5, BL-01 6569408949 item 1): a panel left over while offline keeps its Retry
// disabled, as the panel's other actions are.
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json" with { type: "json" };
import { ErrorPanel } from "./ErrorPanel.tsx";

const html = (node: ReactNode): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const retry = (out: string): string => /<button[^>]*>Retry<\/button>/.exec(out)?.[0] ?? "";

describe("ErrorPanel Retry", () => {
  const noop = (): void => undefined;
  it("is enabled by default and disabled when the caller says so (offline)", () => {
    expect(retry(html(<ErrorPanel title="x" reference={null} onRetry={noop} />))).not.toContain('disabled=""');
    expect(retry(html(<ErrorPanel title="x" reference={null} onRetry={noop} disabled />))).toContain(
      'disabled=""',
    );
  });
});
