// M2-09 AC 7 (component side) and AC 8/9 (rendering): the audit list's states, rendered server-side with the
// real messages. "Filtered empty" shows "No entries match these filters." + "Clear filters"; "Load older"
// shows while a next cursor exists; a failed "Load older" keeps the loaded rows and offers Retry; an
// expanded row's detail is literal text. The filters' narrowing itself runs in SQL (audit.int.test.ts).
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { ApiError } from "../../lib/api.ts";
import type { AuditEntry, AuditPageData } from "../../lib/dispute-view.ts";
import { AuditBody, auditPath, type AuditBodyProps } from "./AuditList.tsx";
import { AuditRow } from "./AuditRow.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

const entry = (n: number, patch: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  at: new Date(Date.UTC(2026, 9, 30, 8, 31, n)).toISOString(),
  actor: "system",
  sandbox: false,
  action: "action.sent",
  detail: { status: 200, debugId: "f1a2b3c4d5e6" },
  refs: { disputeId: "PP-D-27153", debugId: "f1a2b3c4d5e6", fingerprint: null, actionId: null },
  ...patch,
});
const page = (items: AuditEntry[], next: string | null = null): AuditPageData => ({
  items,
  next,
  workspace: { timezone: "Asia/Kolkata" },
});
const noop = () => undefined;
const body = (p: Partial<AuditBodyProps>, locale: "en" | "hi" = "en") =>
  html(
    <AuditBody
      data={page([])}
      error={undefined}
      isValidating={false}
      rows={[]}
      filtersActive={false}
      next={null}
      olderError={null}
      olderBusy={false}
      onRetry={noop}
      onClear={noop}
      onLoadOlder={noop}
      {...p}
    />,
    locale,
  );

describe("audit list states", () => {
  it("empty: the spec's sentence (EN and HI)", () => {
    expect(body({})).toContain(
      "Nothing yet. Every proposal, approval and PayPal call will be recorded here.",
    );
    expect(body({}, "hi")).toContain(hi.audit.empty);
  });

  it("filtered empty: 'No entries match these filters.' with 'Clear filters'", () => {
    const out = body({ filtersActive: true });
    expect(out).toContain("No entries match these filters.");
    expect(out).toContain(`>${en.auditLog.filters.clear}</button>`);
  });

  it("groups rows by day and offers 'Load older' while a next cursor exists", () => {
    const rows = [entry(3), entry(2), entry(1)];
    const out = body({ data: page(rows, "c1"), rows, next: "c1" });
    expect(out.match(/data-testid="audit-day"/g)).toHaveLength(1);
    expect(out.match(/data-testid="audit-row"/g)).toHaveLength(3);
    expect(out).toMatch(new RegExp(`data-testid="load-older"[^>]*>${en.auditLog.loadOlder}<`));
  });

  it("a failed 'Load older' keeps the loaded rows and offers Retry with the reference", () => {
    const rows = [entry(2), entry(1)];
    const out = body({
      data: page(rows, "c1"),
      rows,
      next: "c1",
      olderError: new ApiError(500, "c0ffee00-5ce7-4d1e-9a7a-000000000500"),
    });
    expect(out.match(/data-testid="audit-row"/g)).toHaveLength(2);
    expect(out).toContain("Couldn&#x27;t load older entries. The entries above are kept.");
    expect(out).toContain(`>${en.common.retry}</button>`);
    expect(out).toContain("c0ffee00-5ce7-4d1e-9a7a-000000000500");
    expect(out).not.toContain('data-testid="load-older"');
  });

  it("error: the ErrorPanel with Retry", () => {
    const out = body({ data: undefined, error: new ApiError(500, "ref-1") });
    expect(out).toContain("Couldn&#x27;t load the audit log");
    expect(out).toContain("ref-1");
  });

  it("builds the query from actor, kind and the ID search", () => {
    expect(auditPath({ actor: null, kind: null, q: "" })).toBe("/api/audit");
    expect(auditPath({ actor: "agent", kind: "disputes", q: "PP-D-1" }, "cur")).toBe(
      "/api/audit?actor=agent&kind=disputes&q=PP-D-1&cursor=cur",
    );
  });
});

describe("AuditRow", () => {
  const row = (e: AuditEntry, locale: "en" | "hi" = "en") =>
    html(
      <ul>
        <AuditRow e={e} locale={locale === "en" ? "en-IN" : "hi-IN"} timeZone="Asia/Kolkata" />
      </ul>,
      locale,
    );

  it("shows the actor as icon + word, the action in words, the result and the debug_id", () => {
    const out = row(entry(1));
    expect(out).toMatch(/data-testid="audit-actor"><svg[^>]*aria-hidden="true"[\s\S]*?Cleared</);
    expect(out).toContain("Completed (200)");
    expect(out).toContain("f1a2b3c4d5e6");
    expect(out).toContain('<time dateTime="2026-10-30T08:31:01.000Z"');
  });

  it("renders detail as literal text (a <script> stays text)", () => {
    const out = row(entry(1, { action: "action.failed", detail: { code: "<script>alert(1)</script>" } }));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("offers no edit or delete affordance", () => {
    const out = row(entry(1)).toLowerCase();
    expect(out).not.toMatch(/>\s*(edit|delete|remove)\s*</);
  });

  it("names the sandbox decision as its own actor", () => {
    const out = row(
      entry(1, { actor: "seller", sandbox: true, action: "scenario.decision_requested", detail: {} }),
    );
    expect(out).toContain("Sandbox decision");
    expect(out).toContain("Simulate PayPal&#x27;s decision (sandbox only)");
  });
});
