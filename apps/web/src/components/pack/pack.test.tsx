// M2-05 component tests, rendered server-side with the real EN/HI messages: verdict rows (word + icon,
// unverifiable reasons), citations (the <mark> is the slice at the offsets), the state banner, model text
// as plain text, the dashboard pack sub-line (AC 10) and the intake's pre-checks and code mapping (AC 4).
import {
  quoteInContext,
  type Facts,
  type PackCitation,
  type PackVerdict,
  type PaymentItem,
} from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { PaymentRow } from "../PaymentRow.tsx";
import { Citation } from "./Citation.tsx";
import { FactsList } from "./FactsList.tsx";
import { formatBytes, intakeError, preCheck } from "./intake-checks.ts";
import { PackStateBanner } from "./PackStateBanner.tsx";
import { VerdictRow } from "./VerdictRow.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const ITEM = "6f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b";
const CHAT = "Asha Rao, 12 Oct:\r\nCan you do 3 concepts + 2 revision rounds for $120? Thanks!";
const QUOTE = "Can you do 3 concepts + 2 revision rounds for $120?";

function cite(): PackCitation {
  const start = CHAT.replace("\r\n", "\n").indexOf(QUOTE);
  const offsets = { start, end: start + QUOTE.length };
  return { evidenceItemId: ITEM, quote: QUOTE, offsets, context: quoteInContext(CHAT, offsets, QUOTE) };
}

const verdict = (patch: Partial<PackVerdict>): PackVerdict => ({
  lineId: "C1",
  line: "Three logo concepts and two rounds of revisions",
  verdict: "met",
  note: null,
  rationale: "The chat agrees the concepts and the delivery PDF shows them.",
  lineCitation: cite(),
  citations: [cite()],
  ...patch,
});
const kindOf = (): string => "client chat";

describe("Citation and VerdictRow", () => {
  it("the <mark> holds exactly the slice at the offsets; the 'quoted:' prefix sits outside it", () => {
    const out = html(<Citation c={cite()} from="client chat" />);
    const mark = /<mark[^>]*>([^<]*)<\/mark>/.exec(out)?.[1];
    expect(text(mark ?? "")).toBe(QUOTE);
    expect(out).toContain(`<span class="sr-only">${en.pack.citation.quoted} </span><mark`);
    expect(out).toContain('href="#evidence-6f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b"');
  });

  it("a met row: verdict word + icon, accessible name with the citation count", () => {
    const out = html(<VerdictRow v={verdict({})} kindOf={kindOf} previous={false} />);
    const name = `${verdict({}).line}: ${en.pack.verdict.met}, 2 citations`;
    expect(out).toContain(["aria", "label"].join("-") + `="${name}"`);
    expect(out).toMatch(/data-verdict="met"[^>]*><svg[^>]*aria-hidden="true"[^]*?Met<\/span>/);
  });

  it.each([
    ["image_only_support", "Image only: can't quote it", "सिर्फ़ तस्वीर है: उद्धरण नहीं दिया जा सकता"],
    ["no_valid_citation", "No citation found", "कोई उद्धरण नहीं मिला"],
  ] as const)("unverifiable (%s) shows its reason in EN and HI", (note, enReason, hiReason) => {
    const v = verdict({ verdict: "unverifiable", note, citations: [] });
    expect(text(html(<VerdictRow v={v} kindOf={kindOf} previous={false} />))).toContain(enReason);
    expect(text(html(<VerdictRow v={v} kindOf={kindOf} previous={false} />, "hi"))).toContain(hiReason);
  });

  it("the model's English rationale is marked lang=en inside the Hindi label (BL-01 6601579774)", () => {
    const out = html(<VerdictRow v={verdict({})} kindOf={kindOf} previous={false} />, "hi");
    expect(out).toContain(`क्यों: <span lang="en">The chat agrees the concepts`);
  });

  it("model text renders as plain text: no element is created from it", () => {
    const evil = `<img src=x onerror=alert(1)> <script>alert(2)</script>`;
    const out = html(
      <VerdictRow v={verdict({ rationale: evil, line: evil })} kindOf={kindOf} previous={false} />,
    );
    expect(out).not.toMatch(/<img|<script/);
    expect(text(out)).toContain(evil);
  });
});

describe("FactsList", () => {
  const f = (patch: Partial<Facts>): Facts => ({
    parties: [],
    amounts: [],
    dates: [],
    deliverables: [],
    delivery_events: [],
    shipment: null,
    instruction_like_lines: [],
    ...patch,
  });
  const src = { evidence_item_id: ITEM, source_quote: "Final files attached" };

  it("sent, opened and accepted are separate groups; values are plain text", () => {
    const facts = f({
      delivery_events: [
        { event: "sent", description: "Final files sent", occurred_at: null, ...src },
        { event: "opened", description: "Client opened the files", occurred_at: null, ...src },
        { event: "accepted", description: "<script>alert(1)</script>", occurred_at: "2026-10-15", ...src },
      ],
    });
    const out = html(<FactsList facts={[{ facts }]} kindOf={kindOf} />);
    for (const g of ["sent", "opened", "accepted"]) expect(out).toContain(`data-group="${g}"`);
    expect(out).not.toContain("<script>");
    expect(text(out)).toContain("2026-10-15 · <script>alert(1)</script>");
  });
});

describe("PackStateBanner", () => {
  const counts = { met: 3, partial: 1, missing: 0, unverifiable: 1 };
  it.each([
    ["checking", "Checking delivery against scope… usually under a minute."],
    ["check_unavailable", "AI is unavailable: facts shown without a verdict."],
    ["stale", "New evidence: re-checking."],
    ["checked", "Checked 31 Oct 2026, 10:00. 3 met, 1 partly met, 0 missing."],
  ] as const)("%s", (view, copy) => {
    const out = html(
      <PackStateBanner view={view} checkedAt="2026-10-31T10:00:00.000Z" counts={counts} timeZone="UTC" />,
    );
    expect(out).toContain('aria-live="polite"');
    expect(text(out).replace(/\s+/g, " ")).toContain(copy.replace(/\s+/g, " ").split(".")[1] ?? copy);
    expect(text(out)).toContain(copy.slice(-20));
  });
});

const payment = (pack: PaymentItem["pack"]): PaymentItem => ({
  id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b",
  captureId: "2FB27654CR016344S",
  amount: { value: "120.00", currency: "USD" },
  receivable: null,
  status: "COMPLETED",
  statusReason: null,
  source: "webhook",
  updatedAt: "2026-10-31T10:00:00.000Z",
  pack,
  hold: null,
});

describe("dashboard pack sub-line (AC 10) and Add proof", () => {
  const checked: PaymentItem["pack"] = {
    id: "1f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b",
    view: "checked",
    hasEvidence: true,
    proofReady: true,
    summary: { scope: "met", delivery: "met", sources: 3 },
  };

  it("reads the verdicts as words with an icon each, never a bare tick", () => {
    const out = html(<PaymentRow p={payment(checked)} timeZone="UTC" flash={false} />);
    const line = /<p[^>]*data-testid="pack-line"[^>]*>([^]*?)<\/p>/.exec(out)?.[1] ?? "";
    expect(text(line)).toBe("Proof pack: scope met · delivery met · client sign-off pending · 3 sources");
    expect(line.match(/<svg/g)?.length).toBe(3);
    expect(out).not.toMatch(/[✓✔☑]/);
    expect(out).not.toContain('data-testid="add-proof"');
  });

  it("partial and missing verdicts read as their words (HI too)", () => {
    const p = payment({ ...checked, summary: { scope: "partial", delivery: "missing", sources: 2 } });
    const line = (l: "en" | "hi") =>
      text(
        /data-testid="pack-line"[^>]*>([^]*?)<\/p>/.exec(
          html(<PaymentRow p={p} timeZone="UTC" flash={false} />, l),
        )?.[1] ?? "",
      );
    expect(line("en")).toBe(
      "Proof pack: scope partly met · delivery missing · client sign-off pending · 2 sources",
    );
    expect(line("hi")).toContain("डिलीवरी नहीं मिला");
    // sweep M5 (BL-01 6601823124 item 5): the glossary term for scope, as in the glossary and the PDF
    expect(line("hi")).toContain("सबूत पैक: तय दायरा");
  });

  it("an empty pack asks for proof with one action to the intake panel", () => {
    const out = html(
      <PaymentRow
        p={payment({ ...checked, view: "empty", hasEvidence: false, proofReady: false, summary: null })}
        timeZone="UTC"
        flash={false}
      />,
    );
    expect(text(out)).toContain("New payment from a buyer. Add proof so it's ready if PayPal asks.");
    expect(out).toMatch(
      /data-testid="add-proof" href="\/en\/payments\/0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b\/pack\?intake=1"/,
    );
    expect(out).not.toContain('data-testid="pack-line"');
  });
});

describe("intake pre-checks (AC 4)", () => {
  it("an 11 MB file is refused before upload with the localised EVIDENCE_TOO_LARGE message", () => {
    const code = preCheck({ name: "big.pdf", type: "application/pdf", size: 11_000_000 });
    expect(code).toBe("evidence_too_large");
    expect(en.pack.errors.evidence_too_large.replace("{size}", formatBytes("en-IN", 11_000_000))).toBe(
      "This file is 11 MB. Files must be under 10 MB.",
    );
  });

  it("types and sizes the server accepts pass; others map to the server's codes", () => {
    expect(preCheck({ name: "a.pdf", type: "application/pdf", size: 9_999_999 })).toBeNull();
    expect(preCheck({ name: "a.png", type: "", size: 100 })).toBeNull();
    expect(preCheck({ name: "a.pdf", type: "application/pdf", size: 10_000_000 })).toBe("evidence_too_large");
    expect(preCheck({ name: "a.html", type: "text/html", size: 10 })).toBe("evidence_type");
    expect(intakeError(413, "evidence_too_large")).toBe("evidence_too_large");
    expect(intakeError(415, "evidence_type")).toBe("evidence_type");
    expect(intakeError(500, "internal")).toBe("generic");
    expect(intakeError(0, null)).toBe("network");
  });
});
