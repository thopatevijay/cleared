// M0-09 measurements against a running `pnpm start` (production build). Writes screenshots, axe JSON
// and measure.json to <repo>/.review/M0-09/ (gitignored). Usage: BASE_URL=http://localhost:3100 node scripts/measure.mjs
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.review/M0-09");
const RUNS = 5;
const EVENT = "[data-cash-event]";
mkdirSync(OUT, { recursive: true });

async function open(browser, url, viewport = { width: 1440, height: 900 }, timezoneId = "Asia/Kolkata") {
  const ctx = await browser.newContext({ viewport, timezoneId });
  const page = await ctx.newPage();
  const consoleMsgs = [];
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message.slice(0, 300)}`));
  const js = [];
  page.on("response", async (r) => {
    if (r.request().resourceType() !== "script") return;
    try {
      const body = await r.body();
      js.push({ url: r.url(), raw: body.length, gzip: gzipSync(body, { level: 9 }).length });
    } catch {
      /* redirected or aborted */
    }
  });
  await page.goto(url, { waitUntil: "load" });
  return { ctx, page, consoleMsgs, js };
}

async function renderMs(page) {
  const h = await page.waitForFunction(
    (sel) => (document.querySelectorAll(sel).length >= 6 ? performance.now() : 0),
    EVENT,
    { timeout: 30_000, polling: "raf" },
  );
  return Math.round(await h.jsonValue());
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sum = (js, k) => js.reduce((a, j) => a + j[k], 0);

async function jsWeight(browser, route) {
  const s = await open(browser, `${BASE}${route}`);
  if (route !== "/") await renderMs(s.page);
  await s.page.waitForLoadState("networkidle");
  const out = { files: s.js.length, raw: sum(s.js, "raw"), gzip: sum(s.js, "gzip") };
  await s.ctx.close();
  return out;
}

async function keyboard(page) {
  const trail = [];
  let reachedEvent = false;
  let enterSelects = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const d = await page.evaluate((sel) => {
      const a = document.activeElement;
      if (!a) return null;
      const ev = a.matches(sel) ? a : (a.querySelector(sel) ?? a.closest(sel));
      return {
        tag: a.tagName.toLowerCase(),
        role: a.getAttribute("role"),
        label: (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 50),
        event: ev ? ev.getAttribute("data-cash-event") : null,
      };
    }, EVENT);
    trail.push(d);
    if (d?.event && !reachedEvent) {
      reachedEvent = true;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      enterSelects = (await page.getByTestId("selected").textContent())?.includes(d.event) ?? false;
      await page.keyboard.press("Escape");
    }
  }
  // Arrow keys inside the grid: focus the first focusable day cell and see whether focus moves.
  const arrows = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? "");
  await page.keyboard.press("ArrowRight");
  const arrowsAfter = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? "");
  return {
    tabStops: trail.length,
    reachedEvent,
    enterSelects,
    arrowMovesFocus: arrows !== arrowsAfter,
    trail,
  };
}

async function axe(page, name) {
  const res = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  writeFileSync(path.join(OUT, `axe-${name}.json`), JSON.stringify(res.violations, null, 2));
  return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
}

// All-day events must stay on their day whatever the viewer's browser zone is.
async function dayPlacement(browser, impl) {
  const out = {};
  for (const tz of ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"]) {
    const s = await open(browser, `${BASE}/${impl}`, undefined, tz);
    await renderMs(s.page);
    out[tz] = await s.page.evaluate((sel) => {
      const r = {};
      for (const e of document.querySelectorAll(sel)) {
        const cell = e.closest("[data-date]");
        r[e.getAttribute("data-cash-event")] = cell ? cell.getAttribute("data-date") : null;
      }
      return r;
    }, EVENT);
    await s.ctx.close();
  }
  return out;
}

async function measure(browser, impl) {
  const route = `/${impl}`;
  const times = [];
  let consoleMsgs = [];
  for (let i = 0; i < RUNS; i++) {
    const s = await open(browser, `${BASE}${route}`);
    times.push(await renderMs(s.page));
    consoleMsgs = consoleMsgs.concat(s.consoleMsgs);
    await s.ctx.close();
  }
  const d = await open(browser, `${BASE}${route}`);
  await renderMs(d.page);
  await d.page.waitForTimeout(500);
  const events = await d.page.locator(EVENT).count();
  await d.page.screenshot({ path: path.join(OUT, `${impl}-1440-light.png`), fullPage: true });
  const watermark = await d.page.evaluate(() => {
    const hits = [];
    for (const el of document.querySelectorAll("body *")) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" ");
      const cs = getComputedStyle(el, "::before").content + " " + getComputedStyle(el, "::after").content;
      const txt = `${own} ${cs}`;
      if (/trial|bryntum|licen[cs]e|evaluation/i.test(txt))
        hits.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 80),
          text: txt.trim().slice(0, 120),
        });
    }
    return hits.slice(0, 10);
  });
  const axeLight = await axe(d.page, `${impl}-light`);
  const kb = await keyboard(d.page);
  const allConsole = consoleMsgs.concat(d.consoleMsgs);
  await d.ctx.close();

  const m = await open(browser, `${BASE}${route}`, { width: 375, height: 812 });
  await renderMs(m.page);
  await m.page.waitForTimeout(500);
  const mobile = await m.page.evaluate(
    (sel) => ({
      scrollWidth: document.documentElement.scrollWidth,
      visibleEvents: [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length,
    }),
    EVENT,
  );
  await m.page.screenshot({ path: path.join(OUT, `${impl}-375-light.png`), fullPage: true });
  const axeMobile = await axe(m.page, `${impl}-375`);
  await m.ctx.close();

  const k = await open(browser, `${BASE}${route}?theme=dark`);
  await renderMs(k.page);
  await k.page.waitForTimeout(800);
  await k.page.screenshot({ path: path.join(OUT, `${impl}-1440-dark.png`), fullPage: true });
  const axeDark = await axe(k.page, `${impl}-dark`);
  await k.ctx.close();

  return {
    impl,
    renderMs: { median: median(times), runs: times },
    events,
    hydrationOrConsole: [...new Set(allConsole)],
    watermark,
    axeLight,
    axeMobile,
    axeDark,
    keyboard: { ...kb, trail: kb.trail.slice(0, 15) },
    mobile,
    dayPlacement: await dayPlacement(browser, impl),
  };
}

const browser = await chromium.launch();
const baseline = await jsWeight(browser, "/");
const result = { base: BASE, at: new Date().toISOString(), baselineJs: baseline, impls: [] };
for (const impl of ["bryntum", "fullcalendar"]) {
  const js = await jsWeight(browser, `/${impl}`);
  const r = await measure(browser, impl);
  r.js = { ...js, addedGzip: js.gzip - baseline.gzip, addedRaw: js.raw - baseline.raw };
  result.impls.push(r);
}
await browser.close();
writeFileSync(path.join(OUT, "measure.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
