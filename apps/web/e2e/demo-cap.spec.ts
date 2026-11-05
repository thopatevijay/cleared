// BL-01 6649565560: a visitor refused by the per-network demo cap sees the rolling 24 h limit, when the
// next slot frees (in their own time zone) and a link to the README's judging guide; never "tomorrow",
// never the empty video placeholder. The 429 is the API's real shape (src/server/handlers/capped.ts),
// fulfilled in the browser so no cap is spent. Locally it writes the ui-reviewer evidence too.
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import hi from "../messages/hi.json" with { type: "json" };
import { capture } from "./support/disputes.ts";

const DIR = fileURLToPath(new URL("../../../.review/BL01-AUDIT/", import.meta.url));
const GUIDE = "https://github.com/thopatevijay/cleared#how-to-judge-in-5-minutes";
const messages = { en, hi } as const;

function reply(details: Record<string, unknown> | null, retryAfter: number) {
  return {
    status: 429,
    contentType: "application/json",
    headers: { "retry-after": String(retryAfter), "x-correlation-id": "cid-e2e-cap" },
    body: JSON.stringify({
      error: { code: "rate_limited", message: "capped", details, correlationId: "cid-e2e-cap" },
    }),
  };
}

test.use({ timezoneId: "Asia/Kolkata" });

for (const locale of ["en", "hi"] as const) {
  test(`demo cap ${locale}: rolling 24 h, the next free slot, the judging guide`, async ({ page }) => {
    const m = messages[locale].landing;
    const retryAt = new Date(Date.now() + 5 * 3600 * 1000 + 23 * 60 * 1000);
    await page.route("**/api/demo", (r) =>
      r.fulfill(reply({ cap: "demo_per_ip", limit: 3, windowHours: 24, retryAt: retryAt.toISOString() }, 19_380)),
    );
    await page.goto(`/${locale}`);
    await page.getByTestId("demo-cta").click();
    const panel = page.getByTestId("demo-cap");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(m.capIp.replace("{limit}", "3"));
    await expect(panel).not.toContainText(locale === "en" ? "tomorrow" : "कल फिर");
    const time = panel.locator("time");
    await expect(time).toHaveAttribute("datetime", retryAt.toISOString());
    await expect(time).toContainText(/\d{2}:\d{2}/);
    await expect(panel.getByRole("link")).toHaveAttribute("href", GUIDE);
    await expect(panel).toContainText("cid-e2e-cap");
    await capture(page, `demo-cap-${locale}`, DIR);

    // no timestamp (an older server): the rolling-window sentence, never a guessed time
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/demo", (r) => r.fulfill(reply(null, 86_400)));
    await page.goto(`/${locale}`);
    await page.getByTestId("demo-cta").click();
    await expect(page.getByTestId("demo-cap")).toContainText(m.capIpNoTime);
    await expect(page.getByTestId("demo-cap").locator("time")).toHaveCount(0);
    await capture(page, `demo-cap-notime-${locale}`, DIR, [375]);
  });
}
