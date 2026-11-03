// M4-04 Lighthouse CI (`pnpm lhci autorun …` at the repo root). Lighthouse needs a running production build
// with data behind a session, so this wrapper:
//   1. starts `next start` and the worker on the msw PayPal stub (as playwright.config.ts does; no network),
//   2. creates a demo seller (POST /api/demo) and seeds the judge path (e2e/support/journey.ts),
//   3. runs `lhci collect` twice into one result set: the public pages without a cookie, then the
//      signed-in pages with the session cookie as an extra header (a cookie on the landing page would
//      redirect it to the dashboard),
//   4. runs `lhci assert` (lighthouserc.json: LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms, median of 3 runs on
//      Lighthouse's mobile preset: simulated Slow 4G and 4× CPU) and `lhci upload`.
// Any other lhci command passes straight through. `--upload.*`, `--collect.*` and `--assert.*` options are
// handed to the matching step. Needs `pnpm --filter @cleared/web build` and a migrated database
// (DATABASE_URL); Chrome is Playwright's Chromium unless CHROME_PATH says otherwise.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request } from "@playwright/test";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(web, "../..");
const lhciBin = join(root, "node_modules/.bin/lhci");
const stub = join(web, "e2e/support/paypal-stub.ts");
const port = Number(process.env["LHCI_PORT"] ?? 3300 + Number(process.env["PORT_OFFSET"] ?? 0));
const origin = `http://localhost:${String(port)}`;

/** The main routes: the judge's first page, the dashboard (EN and HI), and the screens it leads to. */
const PUBLIC_PATHS = ["/en"];
const signedInPaths = (j: { paymentId: string; holdId: string; disputeRowId: string }) => [
  "/en/payments",
  "/hi/payments",
  `/en/payments/${j.paymentId}/pack`,
  "/en/holds",
  `/en/holds/${j.holdId}`,
  `/en/disputes/${j.disputeRowId}`,
  "/en/calendar",
];

function lhci(args: readonly string[]): void {
  const r = spawnSync(lhciBin, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`lhci ${args[0] ?? ""} exited ${String(r.status)}`);
}

/** `--upload.target=x` → `{ upload: ["--target=x"] }`; anything unprefixed goes to every step. */
function splitArgs(args: readonly string[]): Record<"collect" | "assert" | "upload" | "all", string[]> {
  const out = {
    collect: [] as string[],
    assert: [] as string[],
    upload: [] as string[],
    all: [] as string[],
  };
  for (const a of args) {
    const m = /^--(collect|assert|upload)\.(.+)$/.exec(a);
    if (m === null) out.all.push(a);
    else out[m[1] as "collect" | "assert" | "upload"].push(`--${m[2] ?? ""}`);
  }
  return out;
}

function start(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  ready: RegExp,
): Promise<ChildProcess> {
  const child = spawn(cmd, args, {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${cmd} not ready in 120 s`));
    }, 120_000);
    const onData = (b: Buffer) => {
      if (ready.test(b.toString())) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} exited ${String(code)} before it was ready`));
    });
  });
}

async function servers(): Promise<ChildProcess[]> {
  const shared = {
    NODE_ENV: "production",
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: "lhci-local-client",
    PAYPAL_CLIENT_SECRET: "lhci-local-secret",
    LOG_LEVEL: "info",
    E2E_WEB_URL: origin,
    NODE_OPTIONS: `--import ${stub}`,
  };
  const webServer = await start(
    "node_modules/.bin/next",
    ["start", "-p", String(port)],
    {
      ...shared,
      E2E_PAYPAL_STUB: "web",
      APP_BASE_URL: origin,
      SESSION_SECRET: randomBytes(32).toString("base64"),
      PAYPAL_WEBHOOK_ID: "WH-LHCI-LOCAL",
      DEMO_WORKSPACES_PER_IP_PER_DAY: "10000",
      DEMO_WORKSPACES_GLOBAL_MAX: "100000",
    },
    /Ready in/,
  );
  const worker = await start(
    "node",
    ["../worker/src/index.ts"],
    { ...shared, E2E_PAYPAL_STUB: "worker", OPS_SCHEDULES: "off", OPENAI_API_KEY: "lhci-local-openai" },
    /"msg":"worker ready"/,
  );
  return [webServer, worker];
}

/** A demo seller with the judge path seeded; returns the cookie header and the signed-in URLs. */
async function seedSeller(): Promise<{ cookie: string; urls: string[] }> {
  const api = await request.newContext({ baseURL: origin });
  const res = await api.post("/api/demo", {
    headers: { origin, "idempotency-key": randomUUID() },
    data: { locale: "en" },
  });
  if (res.status() !== 201) throw new Error(`POST /api/demo → ${String(res.status())}`);
  const cookie = (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // the journey helpers drive a Playwright page; a headless one on our origin carries the same session
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ baseURL: origin, storageState: await api.storageState() });
    const page = await ctx.newPage();
    await page.goto("/en/payments");
    const { seedWorkspace } = await import("../e2e/support/journey.ts");
    const ws = ((await (await page.request.get("/api/workspace")).json()) as { workspace: { id: string } })
      .workspace.id;
    const j = await seedWorkspace(page, ws);
    return { cookie, urls: signedInPaths(j).map((p) => origin + p) };
  } finally {
    await browser.close();
    await api.dispose();
  }
}

function rcWith(collect: Record<string, unknown>): string {
  const base = JSON.parse(readFileSync(join(root, "lighthouserc.json"), "utf8")) as {
    ci: { collect: Record<string, unknown> & { settings?: Record<string, unknown> } };
  };
  const merged = {
    ...base,
    ci: {
      ...base.ci,
      collect: {
        ...base.ci.collect,
        ...collect,
        settings: { ...base.ci.collect.settings, ...(collect["settings"] as object | undefined) },
      },
    },
  };
  const dir = join(tmpdir(), "cleared-lhci");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `lighthouserc-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(merged, null, 2));
  return file;
}

async function autorun(args: readonly string[]): Promise<void> {
  if (!existsSync(join(web, ".next/BUILD_ID")))
    throw new Error("no production build: run the web build first");
  if (process.env["CHROME_PATH"] === undefined && existsSync(chromium.executablePath()))
    process.env["CHROME_PATH"] = chromium.executablePath();
  const a = splitArgs(args);
  const procs = await servers();
  try {
    const { cookie, urls } = await seedSeller();
    lhci([
      "collect",
      `--config=${rcWith({ url: PUBLIC_PATHS.map((p) => origin + p) })}`,
      ...a.collect,
      ...a.all,
    ]);
    lhci([
      "collect",
      "--additive",
      `--config=${rcWith({ url: urls, settings: { extraHeaders: JSON.stringify({ Cookie: cookie }) } })}`,
      ...a.collect,
      ...a.all,
    ]);
  } finally {
    for (const p of procs) p.kill("SIGTERM");
  }
  const rc = `--config=${join(root, "lighthouserc.json")}`;
  // upload first: the reports are kept even when an assertion fails
  lhci(["upload", rc, ...a.upload, ...a.all]);
  lhci(["assert", rc, ...a.assert, ...a.all]);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "autorun") {
  autorun(rest).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  const r = spawnSync(lhciBin, process.argv.slice(2), { cwd: root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
