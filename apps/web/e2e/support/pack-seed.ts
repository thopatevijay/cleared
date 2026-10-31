// M2-05 E2E support (local only): a demo seller, and payments with packs seeded straight into the local
// database the way M1-04 (payment + its empty pack), M2-01 (evidence items), M2-03 (facts rows) and M2-04
// (a check version) leave them. Evidence is the M0 synthetic sample pack (fixtures/samples/evidence/);
// verdict quotes are cut from it at real offsets, as M2-04's verbatim check stores them.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXTRACT_PROMPT, FactsSchema, WorkspaceIdSchema, type Facts, type Verdict } from "@cleared/core";
import { normaliseForQuote } from "@cleared/core/proof/verbatim";
import { extractedFactsRepo, forWorkspace, scopeChecksRepo, withTransaction, type Db } from "@cleared/db";
import type { Page } from "@playwright/test";

export const SAMPLES = new URL("../../../../fixtures/samples/evidence/", import.meta.url);
export const sample = (name: string): string => readFileSync(new URL(name, SAMPLES), "utf8");
export const samplePath = (name: string): string => new URL(name, SAMPLES).pathname;

/** Signs in as a fresh demo seller in `locale`; returns the workspace id. */
export async function demoSeller(page: Page, locale: "en" | "hi" = "en"): Promise<string> {
  await page.context().clearCookies();
  await page.goto(`/${locale}`);
  await page.getByTestId("demo-cta").click();
  await page.waitForURL(`**/${locale}/payments`);
  const res = await page.request.get("/api/workspace");
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

const captureId = (): string => randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase();

/** A mirrored COMPLETED capture and its empty pack (what the capture sync now writes). */
export async function seedPayment(db: Db, ws: string, amount = "120.00") {
  const r = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const payment = await r.payments.insert({
    captureId: captureId(),
    orderId: captureId(),
    amount,
    currency: "USD",
    receivableAmount: (Number(amount) * 0.9614).toFixed(2),
    receivableCurrency: "USD",
    status: "COMPLETED",
    source: "webhook",
    paypalUpdatedAt: new Date(),
  });
  const pack = await r.proofPacks.insert({ paymentId: payment.id });
  return { paymentId: payment.id, packId: pack.id };
}

export async function addTextItem(
  db: Db,
  ws: string,
  packId: string,
  kind: "scope" | "communication",
  text: string,
) {
  const sha256 = createHash("sha256")
    .update(text.normalize("NFC").replaceAll("\r\n", "\n"), "utf8")
    .digest("hex");
  return forWorkspace(db, WorkspaceIdSchema.parse(ws)).evidenceItems.insert({ packId, kind, sha256, text });
}

export const EMPTY_FACTS: Facts = FactsSchema.parse({
  parties: [],
  amounts: [],
  dates: [],
  deliverables: [],
  delivery_events: [],
  shipment: null,
  instruction_like_lines: [],
});

export interface SeedLine {
  readonly line: string;
  readonly verdict: Verdict;
  readonly note?: "no_valid_citation" | "image_only_support" | "no_scope_quote" | "model_unverifiable";
  readonly scopeQuote?: string;
  readonly quotes?: readonly string[];
  readonly rationale?: string;
}

/** A pack checked by M2-04: a brief and a chat, facts rows, one check version, state `checked`. */
export async function seedChecked(
  db: Db,
  ws: string,
  lines: readonly SeedLine[],
  opts: { facts?: (chatId: string) => Facts; state?: "checked" | "stale" | "collecting" } = {},
) {
  const wsId = WorkspaceIdSchema.parse(ws);
  const { paymentId, packId } = await seedPayment(db, ws);
  const brief = await addTextItem(db, ws, packId, "scope", sample("brief-logo.txt"));
  const chat = await addTextItem(db, ws, packId, "communication", sample("chat-logo.txt"));
  const cite = (item: { id: string; sha256: string; text: string | null }, quote: string) => {
    const start = normaliseForQuote(item.text ?? "").indexOf(quote);
    if (start < 0) throw new Error(`quote not in item: ${quote}`);
    return {
      evidence_item_id: item.id,
      quote,
      offsets: { start, end: start + quote.length },
      sha256: item.sha256,
    };
  };
  await withTransaction(db, async (tx) => {
    const facts = extractedFactsRepo(db, wsId);
    for (const item of [brief, chat]) {
      const f = item.id === chat.id && opts.facts !== undefined ? opts.facts(chat.id) : EMPTY_FACTS;
      await facts.insert(
        {
          evidenceItemId: item.id,
          facts: f,
          model: "gpt-6-luna",
          runId: null,
          promptVersion: EXTRACT_PROMPT.id,
        },
        tx,
      );
    }
    if (lines.length === 0) return;
    await scopeChecksRepo(db, wsId).insertCheck(
      {
        packId,
        evidenceSetHash: createHash("sha256").update(packId).digest("hex"),
        promptVersion: "check_scope@v1",
        runId: null,
        lines: lines.map((l, i) => ({
          lineId: `C${String(i + 1)}`,
          line: l.line,
          verdict: l.verdict,
          modelVerdict: l.verdict,
          note: l.note ?? null,
          rationale: l.rationale ?? "",
          lineCitation: l.scopeQuote === undefined ? null : cite(brief, l.scopeQuote),
          citations: (l.quotes ?? []).map((q) => cite(chat, q)),
        })),
      },
      tx,
    );
  });
  const state = opts.state ?? (lines.length > 0 ? "checked" : "collecting");
  await forWorkspace(db, wsId).proofPacks.update(packId, {
    state,
    checkedAt: lines.length > 0 ? new Date() : null,
  });
  return { paymentId, packId, briefId: brief.id, chatId: chat.id };
}

/** The `check_unavailable` entry M2-04 writes when the AI is down or over budget. */
export async function markUnavailable(db: Db, ws: string, packId: string, status = "degraded") {
  await forWorkspace(db, WorkspaceIdSchema.parse(ws)).auditLog.insert({
    actor: "agent",
    action: "check_unavailable",
    detail: {
      packId,
      runId: null,
      status,
      reason: "the AI provider is unavailable",
      promptVersion: "check_scope@v1",
    },
  });
}

/** The logo sample's lines as M2-04 grades them (met, partial, missing, and both unverifiable reasons). */
export const LOGO_LINES: readonly SeedLine[] = [
  {
    line: "Provide the primary logo in SVG and PNG formats.",
    verdict: "met",
    scopeQuote: "Primary logo in SVG and PNG formats.",
    quotes: ["Final files are uploaded: SVG, PNG, the black and white variants and the brand guide."],
    rationale: "The seller says the SVG and PNG files were uploaded.",
  },
  {
    line: "Up to two revision rounds, requested in the order chat.",
    verdict: "partial",
    scopeQuote: "Revisions: up to two rounds, requested in the order chat.",
    quotes: ["Done, revision 1 uploaded with the thinner leaf."],
    rationale: "One revision round is shown; a second was not requested.",
  },
  {
    line: "The editable source file in Adobe Illustrator (.ai) format.",
    verdict: "missing",
    scopeQuote: "The editable source file in Adobe Illustrator (.ai) format.",
    quotes: ["Still waiting for the source file, please."],
    rationale: "The buyer is still waiting for the source file.",
  },
  {
    line: "Three colour variants: full colour, black, and white.",
    verdict: "unverifiable",
    note: "image_only_support",
    scopeQuote: "Three colour variants: full colour, black, and white.",
    rationale: "Only the screenshot shows the variants.",
  },
  {
    line: "A one-page brand guide listing the colour codes.",
    verdict: "unverifiable",
    note: "no_valid_citation",
    scopeQuote: "A one-page brand guide (PDF) listing the colour codes.",
    rationale: "No quote shows the page count.",
  },
];
