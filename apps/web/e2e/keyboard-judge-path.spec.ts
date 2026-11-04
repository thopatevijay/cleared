// M4-04 AC 2 (local, fixture replay): the judge path end to end with the keyboard alone. After the first
// page load nothing but Tab, Shift+Tab, Enter and Space is pressed: no click, no goto. Every Tab stop
// asserts a visible focus indicator that the sticky header does not hide (WCAG 2.4.7, 2.4.11).
// Path: landing → "Try as demo seller" → dashboard → proof pack → dashboard → held money → hold detail →
// held money → cash calendar (month moves by button, an event opened with Space) → dispute review (the
// approval dialog opened and closed) → disputes → dashboard → audit log → notifications.
import { expect, test, type Page } from "@playwright/test";
import { seedWorkspace, type Journey } from "./support/journey.ts";
import { expectVisibleFocus, tabTo } from "./support/keyboard.ts";
import { local } from "./support/review.ts";
import { CashCalendarResponseSchema } from "@cleared/core";

test.skip(!local, "local only: fixture replay");

const link = (page: Page, href: string) => page.locator(`a[href="/en${href}"]`).first();

/** Tab to `href`'s link, then Enter; waits for the new page. */
async function follow(page: Page, href: string, where: string): Promise<void> {
  const target = link(page, href);
  await target.waitFor({ timeout: 30_000 });
  await tabTo(page, target, where);
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/en${href.split("?")[0] ?? href}`);
}

for (const width of [1280, 375]) {
  test(`keyboard only: the judge path at ${String(width)} px`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
    await page.context().clearCookies();
    await page.goto("/en");

    await test.step("landing → demo", async () => {
      const cta = page.getByTestId("demo-cta");
      await cta.waitFor();
      // the first stop is the skip link
      await page.keyboard.press("Tab");
      await expectVisibleFocus(page, "landing skip link");
      await expect(page.locator(":focus")).toHaveAttribute("href", "#main");
      await tabTo(page, cta, "landing");
      await page.keyboard.press("Enter");
      await page.waitForURL("**/en/payments");
    });

    const ws = ((await (await page.request.get("/api/workspace")).json()) as { workspace: { id: string } })
      .workspace.id;
    const j: Journey = await seedWorkspace(page, ws);

    await test.step("dashboard → proof pack → dashboard", async () => {
      // the dashboard polls every 5 s: the seeded rows arrive without a reload
      await expect(link(page, `/payments/${j.paymentId}/pack`)).toBeVisible({ timeout: 30_000 });
      await follow(page, `/payments/${j.paymentId}/pack`, "dashboard → pack");
      await page.getByTestId("verdict-row").first().waitFor();
      await follow(page, "/payments", "pack → dashboard");
    });

    await test.step("held money → hold detail → held money", async () => {
      await follow(page, "/holds", "dashboard → holds");
      await follow(page, `/holds/${j.holdId}`, "holds → hold detail");
      await page.getByTestId("hold-detail").waitFor();
      await follow(page, "/holds", "hold detail → holds");
    });

    await test.step("cash calendar: month moves by button, an event opened with Space", async () => {
      await follow(page, "/calendar", "holds → calendar");
      await page.getByTestId("calendar-area").waitFor();
      if (width >= 768) {
        const title = page.getByTestId("month-title");
        const month = await title.innerText();
        await tabTo(page, page.getByRole("button", { name: "Next month" }), "calendar next");
        await page.keyboard.press("Enter");
        await expect(title).not.toHaveText(month);
        await page.keyboard.press("Shift+Tab");
        await expectVisibleFocus(page, "calendar previous");
        await page.keyboard.press("Enter");
        await expect(title).toHaveText(month);
        const cal = CashCalendarResponseSchema.parse(
          await (await page.request.get("/api/cash-calendar")).json(),
        );
        const deadline = cal.events.find((e) => e.kind === "dispute_deadline");
        expect(deadline, "the seeded dispute has a deadline on the calendar").toBeDefined();
        const ev = page.locator(`.cash-bryntum [data-event-id="${deadline?.id ?? ""}"]`);
        await expect(ev).toBeAttached({ timeout: 60_000 });
        // the grid has drawn the month the buttons returned to (no slide: animateTimeShift is off): Tab
        // once its bars are on screen
        await expect
          .poll(() => ev.evaluate((el) => el.getBoundingClientRect().left), { timeout: 10_000 })
          .toBeGreaterThanOrEqual(0);
        await tabTo(page, ev, "calendar → deadline event", 150);
        await page.keyboard.press(" ");
        await page.waitForURL(`**/en/disputes/${j.disputeRowId}`);
      } else {
        // below 768 px the List view is the default: its rows are links
        const row = link(page, `/disputes/${j.disputeRowId}`);
        await row.waitFor();
        await tabTo(page, row, "calendar list → dispute", 150);
        await page.keyboard.press("Enter");
        await page.waitForURL(`**/en/disputes/${j.disputeRowId}`);
      }
    });

    await test.step("dispute review: the approval dialog opens and closes by keyboard", async () => {
      const approve = page.getByTestId("approve");
      await expect(approve).toBeEnabled({ timeout: 30_000 });
      await tabTo(page, approve, "dispute → approve", 150);
      await page.keyboard.press("Enter");
      const dialog = page.getByTestId("approve-dialog");
      await expect(dialog).toBeVisible();
      await expectVisibleFocus(page, "approval dialog");
      await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
      await page.keyboard.press("Space");
      await expect(dialog).toBeHidden();
      await expect(approve).toBeFocused();
      await expectVisibleFocus(page, "focus back on Approve");
      await follow(page, "/disputes", "dispute → disputes");
      await page.getByTestId("dispute-row").first().waitFor();
      await follow(page, "/payments", "disputes → dashboard");
    });

    await test.step("audit log → notifications", async () => {
      await follow(page, "/audit", "dashboard → audit");
      await page.getByTestId("audit-list").waitFor();
      // the bell: a panel from 768 px (focus moves to its heading; "See all" leads on), the page below
      const bell = page.locator("header button[aria-expanded]");
      await tabTo(page, bell, "audit → bell");
      await page.keyboard.press("Enter");
      if (width >= 768) {
        const panel = page.getByRole("dialog");
        await expect(panel).toBeVisible();
        await follow(page, "/notifications", "bell panel → all notifications");
      } else {
        await page.waitForURL("**/en/notifications");
      }
      await page.getByTestId("notification").first().waitFor();
    });
  });
}
