// M4-04 keyboard support: Tab through a page asserting, at every stop, a visible focus indicator (WCAG
// 2.4.7: the 2 px focus outline from components.md, or a ring) that the sticky header does not hide
// (WCAG 2.4.11 focus not obscured). Only Tab, Shift+Tab, Enter and Space are pressed.
import { expect, type Locator, type Page } from "@playwright/test";

export interface FocusInfo {
  readonly tag: string;
  readonly label: string;
  readonly visibleIndicator: boolean;
  readonly focusVisible: boolean;
  readonly obscured: boolean;
  readonly inViewport: boolean;
  /** what is drawn at the element's centre (for the failure message) */
  readonly onTop: string;
}

/** The focused element's indicator and whether the sticky header covers it. */
export async function focusInfo(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return null;
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
    const ring = cs.boxShadow !== "none" && cs.boxShadow !== "";
    const r = el.getBoundingClientRect();
    // 2.4.11 is "not entirely hidden": obscured when none of five points inside the element (its centre
    // and four inset corners) has the element, or something inside it, on top (the sticky header or a
    // fixed bar over it would be on top instead). A zero-size element (a focus sentinel) can't be judged.
    const points: [number, number][] = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    const target = el;
    const tops = points.map(([x, y]) => document.elementFromPoint(x, y));
    const obscured =
      r.width > 0 &&
      r.height > 0 &&
      !tops.some((top) => top !== null && (target.contains(top) || top.contains(target)));
    const inViewport =
      r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText).trim().slice(0, 60);
    const onTop = tops[0];
    return {
      tag: el.tagName.toLowerCase(),
      label,
      visibleIndicator: outline || ring,
      focusVisible: el.matches(":focus-visible"),
      obscured,
      inViewport,
      onTop:
        onTop === null || onTop === undefined
          ? `nothing (rect x ${r.left.toFixed(0)}..${r.right.toFixed(0)} y ${r.top.toFixed(0)}..${r.bottom.toFixed(0)} of ${String(window.innerWidth)}×${String(window.innerHeight)})`
          : `<${onTop.tagName.toLowerCase()} class="${onTop.getAttribute("class") ?? ""}">`,
    };
  });
}

/** Asserts the focused element shows its indicator and is not hidden under the sticky header. */
export async function expectVisibleFocus(page: Page, where: string): Promise<FocusInfo> {
  const f = await focusInfo(page);
  expect(f, `${where}: something has focus`).not.toBeNull();
  const info = f as FocusInfo;
  const what = `${where}: <${info.tag}> "${info.label}"`;
  expect(info.focusVisible, `${what} matches :focus-visible`).toBe(true);
  expect(info.visibleIndicator, `${what} shows a focus outline or ring`).toBe(true);
  expect(info.obscured, `${what} is not hidden (on top: ${info.onTop})`).toBe(false);
  expect(info.inViewport, `${what} is scrolled into view`).toBe(true);
  return info;
}

/**
 * Presses Tab (or Shift+Tab when `target` comes before the focused element) until `target` has focus, at
 * most `max` stops, asserting a visible focus indicator at every stop on the way. Returns the presses.
 */
export async function tabTo(page: Page, target: Locator, where: string, max = 80): Promise<number> {
  await target.waitFor({ state: "attached", timeout: 30_000 });
  const backwards = await target.evaluate((el) => {
    const active = document.activeElement;
    if (active === null || active === document.body) return false;
    return (el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  const key = backwards ? "Shift+Tab" : "Tab";
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(key);
    await expectVisibleFocus(page, `${where} (Tab ${String(i)})`);
    if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))) {
      return i;
    }
  }
  throw new Error(`${where}: ${String(max)} Tab presses never reached the target`);
}
