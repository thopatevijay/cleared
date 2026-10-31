// M2-05 proof-pack page (local only: the web and worker run with the msw PayPal and OpenAI stubs, no live
// call). The happy path drives the real pipeline: M2-01 intake → M2-03 extract → M2-04 check, each AI step
// answered by the recorded logo-pack responses. The other states are seeded into the local database as
// those tickets leave them. Review screenshots and axe results go to .review/M2-05/ (gitignored).
import { fileURLToPath } from "node:url";
import { normaliseForQuote } from "@cleared/core/proof/verbatim";
import { closeDb, createDb, databaseUrl, type Db } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import {
  demoSeller,
  EMPTY_FACTS,
  LOGO_LINES,
  markUnavailable,
  sample,
  samplePath,
  seedChecked,
  seedPayment,
} from "./support/pack-seed.ts";
import { capture, local, REVIEW } from "./support/review.ts";

const XSS = "<img src=x onerror=alert(1)>";
let db: Db;

test.beforeAll(() => {
  db = createDb(databaseUrl());
});
test.afterAll(async () => {
  await closeDb(db);
});
test.beforeEach(({ page }) => {
  test.skip(!local, "seeds the local database");
  // model text must never run: any dialog fails the test
  page.on("dialog", (d) => {
    throw new Error(`dialog opened: ${d.message()}`);
  });
});

const banner = (page: Page) => page.getByTestId("pack-banner");
const packUrl = (locale: string, paymentId: string, q = "") => `/${locale}/payments/${paymentId}/pack${q}`;
/** Opens the pack page and waits until the client is hydrated (the intake's handlers are attached). */
async function gotoPack(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
}

async function addText(page: Page, kind: string, text: string): Promise<void> {
  await page.getByTestId("intake-kind").selectOption(kind);
  await page.getByTestId("intake-text").fill(text);
  await page.getByTestId("intake-add").click();
  await expect(page.getByTestId("intake-added")).toBeVisible();
}

/** Every <mark> equals the item's normalised text sliced at the citation's offsets. */
async function assertQuotesAreSlices(page: Page): Promise<number> {
  const cites = await page.getByTestId("citation").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-evidence-id") ?? "",
      start: Number(el.getAttribute("data-start")),
      end: Number(el.getAttribute("data-end")),
      mark: el.querySelector("mark")?.textContent ?? null,
    })),
  );
  for (const c of cites) {
    const rows = await db.$client.query<{ text: string }>("select text from evidence_items where id = $1", [
      c.id,
    ]);
    const text = rows.rows[0]?.text ?? "";
    expect(c.mark, `citation on ${c.id} ${String(c.start)}..${String(c.end)}`).toBe(
      normaliseForQuote(text).slice(c.start, c.end),
    );
  }
  return cites.length;
}

test("AC 1–2: a PDF, then the brief and the chat: collecting → checking → checked, quotes are exact slices", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const ws = await demoSeller(page);
  const { paymentId } = await seedPayment(db, ws);
  await gotoPack(page, packUrl("en", paymentId));
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(banner(page)).toHaveAttribute("data-state", "empty");

  // delivery first: no scope source yet, so the pack is collecting
  await page.getByTestId("intake-kind").selectOption("delivery");
  await page.getByTestId("intake-file").setInputFiles(samplePath("delivery-logo.pdf"));
  await page.getByTestId("intake-add").click();
  await expect(banner(page)).toHaveAttribute("data-state", "collecting");
  await expect(banner(page)).toContainText("Evidence added. Add the delivery too");
  await expect(page.getByTestId("evidence-item")).toHaveCount(1);

  // the agreement and the chat: the worker extracts both, then checks the pack
  await addText(page, "scope", sample("brief-logo.txt"));
  await addText(page, "communication", sample("chat-logo.txt"));
  await expect(banner(page)).toHaveAttribute("data-state", "checking");
  await expect(banner(page)).toContainText("Checking delivery against scope");
  await expect(banner(page)).toHaveAttribute("data-state", "checked", { timeout: 120_000 });
  await expect(banner(page)).toContainText(/Checked .*\d+ met, \d+ partly met, \d+ missing\./);
  await expect(page.getByTestId("pack-live")).toContainText("Verdicts updated:");

  const rows = page.getByTestId("verdict-row");
  expect(await rows.count()).toBeGreaterThan(3);
  await expect(page.locator('[data-testid="verdict-row"][data-verdict="met"]').first()).toBeVisible();
  await expect(page.getByTestId("quote").first()).toBeVisible();
  // the chat's injection line is flagged and shown as data
  await expect(page.getByTestId("injection-flag").first()).toBeVisible();
  expect(await assertQuotesAreSlices(page)).toBeGreaterThan(3);
  // a citation expands in place (Enter) and collapses (Escape)
  const toggle = page.getByTestId("citation").first().getByRole("button");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await capture(page, "en-checked-live");
});

test("AC 3 + 5: unverifiable reasons; AI unavailable shows facts and no verdicts; model text stays literal", async ({
  page,
}) => {
  const ws = await demoSeller(page);
  const facts = (chatId: string) => ({
    ...EMPTY_FACTS,
    deliverables: [
      {
        kind: "delivered" as const,
        description: `Logo files ${XSS}`,
        evidence_item_id: chatId,
        source_quote: XSS,
      },
    ],
    delivery_events: (["sent", "opened", "accepted"] as const).map((event) => ({
      event,
      description: {
        sent: "Final files sent",
        opened: "Client reviewed draft 1",
        accepted: "Client approved revision 1",
      }[event],
      occurred_at: "2026-10-18",
      evidence_item_id: chatId,
      source_quote: {
        sent: "Final files are uploaded",
        opened: "We like direction B.",
        accepted: "Perfect, approved.",
      }[event],
    })),
  });
  const lines = LOGO_LINES.map((l, i) => (i === 0 ? { ...l, rationale: `${l.rationale ?? ""} ${XSS}` } : l));
  const checked = await seedChecked(db, ws, lines, { facts });
  await gotoPack(page, packUrl("en", checked.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "checked");
  await expect(page.locator('[data-verdict="unverifiable"] [data-testid="unverifiable-reason"]')).toHaveText([
    "Image only: can't quote it",
    "No citation found",
  ]);
  // AC 5: the literal text is on the page, and no element was made from it
  await expect(page.getByTestId("rationale").first()).toContainText(XSS);
  await expect(page.getByTestId("fact").first()).toContainText(XSS);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await assertQuotesAreSlices(page)).toBe(8);
  await capture(page, "en-checked");

  // check_unavailable: facts and evidence render; verdicts show "—"
  const down = await seedChecked(db, ws, [], { facts });
  await markUnavailable(db, ws, down.packId);
  await gotoPack(page, packUrl("en", down.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "check_unavailable");
  await expect(banner(page)).toHaveText("AI is unavailable: facts shown without a verdict.");
  await expect(page.getByTestId("no-verdict")).toBeVisible();
  await expect(page.getByTestId("verdict-row")).toHaveCount(0);
  await expect(page.getByTestId("fact").first()).toBeVisible();
  await capture(page, "en-ai-unavailable");

  const budget = await seedChecked(db, ws, []);
  await markUnavailable(db, ws, budget.packId, "budget_exceeded");
  await gotoPack(page, packUrl("en", budget.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "budget_exceeded");
  await expect(page.getByTestId("verdict-row")).toHaveCount(0);
  await capture(page, "en-budget");
});

test("AC 4: an 11 MB upload shows the localised EVIDENCE_TOO_LARGE message and adds nothing", async ({
  page,
}) => {
  const ws = await demoSeller(page);
  const { paymentId, packId } = await seedPayment(db, ws);
  const big = {
    name: "delivery-scan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(11_200_000, 0x20),
  };
  for (const [locale, message] of [
    ["en", "This file is 11.2 MB. Files must be under 10 MB."],
    ["hi", "यह फ़ाइल 11.2 MB की है। फ़ाइल 10 MB से छोटी होनी चाहिए।"],
  ] as const) {
    await gotoPack(page, packUrl(locale, paymentId));
    await page.getByTestId("intake-file").setInputFiles(big);
    await expect(page.getByTestId("intake-error")).toHaveText(message);
    await expect(page.getByTestId("intake-added")).toBeEmpty();
    if (locale === "en") await capture(page, "en-upload-rejected");
  }
  // the server's typed refusal (an HTML file named .png passes the browser's check): same localised copy
  await gotoPack(page, packUrl("en", paymentId));
  await page
    .getByTestId("intake-file")
    .setInputFiles(fileURLToPath(new URL("../../../fixtures/files/html-named.png", import.meta.url)));
  await page.getByTestId("intake-kind").selectOption("delivery");
  await page.getByTestId("intake-add").click();
  await expect(page.getByTestId("intake-error")).toHaveText("Only JPG, PNG, GIF and PDF files can be added.");
  await capture(page, "en-upload-rejected-server");
  const n = await db.$client.query<{ n: string }>(
    "select count(*)::text n from evidence_items where pack_id = $1",
    [packId],
  );
  expect(n.rows[0]?.n).toBe("0");
  await expect(page.getByTestId("evidence-item")).toHaveCount(0);
});

test("AC 6: another workspace's pack URL renders the not-found page; the API says 404", async ({ page }) => {
  const owner = await demoSeller(page);
  const { paymentId, packId } = await seedPayment(db, owner);
  await demoSeller(page); // a second, unrelated demo workspace
  const res = await page.goto(packUrl("en", paymentId));
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("not-found")).toContainText("This payment isn't in your workspace.");
  expect((await page.request.get(`/api/packs/${packId}`)).status()).toBe(404);
  await capture(page, "en-not-found");
});

test("AC 7: every state axe-clean at 360–1440 px light/dark; keyboard-only intake", async ({ page }) => {
  test.setTimeout(300_000);
  const ws = await demoSeller(page);
  const empty = await seedPayment(db, ws);
  await gotoPack(page, packUrl("en", empty.paymentId));
  await capture(page, "en-empty");

  // keyboard only: Tab from the top of the page to the chat box, type, Tab to "Add", Enter
  await gotoPack(page, packUrl("en", empty.paymentId));
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  const text = page.getByTestId("intake-text");
  const path: string[] = [];
  for (let i = 0; i < 30 && !(await text.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press("Tab");
    path.push(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? "none"));
  }
  await expect(text, path.join("\n")).toBeFocused();
  await page.keyboard.type("Asha: please send the final logo files by Friday.");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("intake-add")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("intake-added")).toContainText("Evidence added");
  await expect(page.getByTestId("evidence-item")).toHaveCount(1);
  await expect(banner(page)).toHaveAttribute("data-state", "checking");

  // seeded (no worker event), so the state holds still for the captures
  const seeded = async (kind: "delivery" | "communication", text: string) => {
    const p = await seedPayment(db, ws);
    await db.$client.query("update proof_packs set state = 'collecting' where id = $1", [p.packId]);
    await db.$client.query(
      "insert into evidence_items (workspace_id, pack_id, kind, sha256, text) values ($1, $2, $3, repeat('a', 64), $4)",
      [ws, p.packId, kind, text],
    );
    return p;
  };
  const checking = await seeded("communication", sample("chat-logo.txt"));
  await gotoPack(page, packUrl("en", checking.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "checking");
  await capture(page, "en-checking");

  const collecting = await seeded("delivery", "Final logo, revision 2 of 2");
  await gotoPack(page, packUrl("en", collecting.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "collecting");
  await capture(page, "en-collecting");

  const stale = await seedChecked(db, ws, LOGO_LINES, { state: "stale" });
  await gotoPack(page, packUrl("en", stale.paymentId));
  await expect(banner(page)).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("verdicts")).toHaveAttribute("data-previous", "true");
  await capture(page, "en-stale");

  // a failed refresh while polling: the last data stays, with the error band (Retry + Reference)
  await page.route("**/api/packs/**", (route) =>
    route.fulfill({
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000500",
      },
      body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
    }),
  );
  await gotoPack(page, packUrl("en", collecting.paymentId));
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 20_000 });
  await capture(page, "en-refresh-error");

  // the first load fails: the full-page error with Retry and Reference
  await page.goto(packUrl("en", stale.paymentId));
  await expect(page.getByTestId("error-panel")).toContainText("Couldn't load this payment");
  await capture(page, "en-error");
  await page.unroute("**/api/packs/**");

  // loading: the read never answers; after 3 s the line appears
  await page.route("**/api/packs/**", () => undefined);
  await page.goto(packUrl("en", stale.paymentId));
  await expect(page.getByTestId("loading")).toBeVisible();
  await expect(page.getByTestId("loading")).toContainText("Loading the proof pack…", { timeout: 6_000 });
  await capture(page, "en-loading");
  await page.unroute("**/api/packs/**");

  // offline: the last data stays, the intake is disabled and says why
  await gotoPack(page, packUrl("en", stale.paymentId));
  await page.context().setOffline(true);
  await expect(page.getByTestId("intake")).toContainText(
    "You're offline. Evidence can be added when you reconnect.",
  );
  await expect(page.getByTestId("intake-add")).toBeDisabled();
  await expect(page.getByTestId("verdict-row").first()).toBeVisible();
  await capture(page, "en-offline");
  await page.context().setOffline(false);

  // 375 px: the intake opened, and a citation expanded in place
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByTestId("intake-open").click();
  await page.getByTestId("intake").screenshot({ path: `${REVIEW}en-intake-open-375-light.png` });
  const chip = page.getByTestId("citation").first();
  await chip.getByRole("button").click();
  await chip.screenshot({ path: `${REVIEW}en-citation-expanded-375-light.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("AC 8: /hi renders every string from hi.json (no missing-key warnings)", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/MISSING_MESSAGE|missing message/i.test(m.text())) problems.push(m.text());
  });
  const ws = await demoSeller(page, "hi");
  const checked = await seedChecked(db, ws, LOGO_LINES);
  const empty = await seedPayment(db, ws);
  for (const [name, id] of [
    ["hi-checked", checked.paymentId],
    ["hi-empty", empty.paymentId],
  ] as const) {
    await gotoPack(page, packUrl("hi", id));
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    const body = await page.locator("body").innerText();
    expect(body, "a raw message key on the page").not.toMatch(/\b(pack|row|dashboard)\.[a-zA-Z]+/);
    await capture(page, name);
  }
  // the dashboard's pack strings in Hindi (summary count, sub-line, Add proof)
  await page.goto("/hi/payments");
  await expect(page.getByTestId("summary-proof-ready")).toContainText("0 भुगतान सबूत के साथ तैयार");
  await expect(page.getByTestId("pack-line")).toContainText("सबूत पैक:");
  await expect(page.getByTestId("add-proof")).toHaveText("सबूत जोड़ें");
  expect(await page.locator("body").innerText()).not.toMatch(/\b(pack|row|dashboard)\.[a-zA-Z]+/);
  await capture(page, "hi-dashboard");
  expect(problems).toEqual([]);
});
