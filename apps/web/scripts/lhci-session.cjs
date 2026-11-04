// Puppeteer script for `lhci collect` (see lhci.ts): puts the demo session in the browser's cookie jar before
// each signed-in URL. An `extraHeaders` Cookie reaches only the document request: Chrome builds the Cookie
// header of the page's own fetches from the jar, so every `/api/*` call came back 401 and the client sent
// the page to `/<locale>?ended=1` (BL-01 6609549510). Lighthouse must also keep the jar: see
// `disableStorageReset` in lhci.ts.
/* global module, URL, process */
module.exports = async (browser, context) => {
  const origin = new URL(context.url).origin;
  const cookies = JSON.parse(process.env.LHCI_SESSION_COOKIES ?? "[]");
  const page = await browser.newPage();
  try {
    for (const c of cookies) {
      await page.setCookie({
        name: c.name,
        value: c.value,
        url: origin,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
    }
  } finally {
    await page.close();
  }
};
