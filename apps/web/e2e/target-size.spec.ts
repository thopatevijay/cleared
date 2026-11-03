// M4-04 AC 3, target size (WCAG 2.5.8): on every route of the judge path, EN at 320 and 1280 px and HI at
// 320 px, every visible interactive element is at least 24 × 24 CSS px. Exempt, as 2.5.8 allows: inline
// text links (an <a> laid out `display: inline` inside a sentence). A form control's target includes its
// <label> (clicking the label operates it), so a native checkbox inside a 44 px label passes.
import { expect, test, type Page } from "@playwright/test";
import { seedJourney, type Locale } from "./support/journey.ts";
import { local } from "./support/review.ts";
import { walkAll } from "./support/walk.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: fixture replay");

const MIN = 24;

/** Visible interactive elements smaller than 24 × 24 (inline text links excepted), described. */
async function undersized(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const SELECTOR = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[role=button]",
      "[role=link]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=tab]",
      "[role=menuitem]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[aria-hidden=true],[inert]"))
        continue;
      let r = el.getBoundingClientRect();
      // visually hidden (the sr-only skip link until focused) or not drawn
      if (r.width <= 1 || r.height <= 1) continue;
      if (el.tagName === "A" && cs.display === "inline") continue;
      const label =
        el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
          ? (el.labels?.[0] ?? null)
          : null;
      if (label !== null) {
        const l = label.getBoundingClientRect();
        const left = Math.min(r.left, l.left);
        const top = Math.min(r.top, l.top);
        r = new DOMRect(left, top, Math.max(r.right, l.right) - left, Math.max(r.bottom, l.bottom) - top);
      }
      if (r.width + 0.5 < min || r.height + 0.5 < min) {
        const name = (el.getAttribute("aria-label") ?? el.innerText).trim().replace(/\s+/g, " ").slice(0, 40);
        const cls = (el.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".");
        out.push(
          `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> "${name}" ${r.width.toFixed(0)}×${r.height.toFixed(0)}`,
        );
      }
    }
    return out;
  }, MIN);
}

async function check(page: Page, name: string): Promise<void> {
  expect.soft(await undersized(page), `targets under ${String(MIN)} px on ${name}`).toEqual([]);
}

for (const [locale, widths] of [
  ["en", [320, 1280]],
  ["hi", [320]],
] as const satisfies readonly (readonly [Locale, readonly number[]])[]) {
  test(`target size ≥ 24 px: every route (${locale})`, async ({ page, browser }) => {
    test.setTimeout(420_000);
    const j = await seedJourney(page, locale);
    await walkAll(page, browser, locale, j, widths, check);
  });
}
