// PayPal webhook setup (M1-04). Idempotent: run it any number of times.
//
//   pnpm tsx --env-file=<path to .env> scripts/setup.ts [--url <base>] [--id-out <file>] [--record]
//       registers `<base>/api/webhooks/paypal` (default $RENDER_WEB_URL) for WEBHOOK_EVENT_TYPES and
//       ensures the webhook lookup. The webhook id goes to --id-out (mode 600) when given, else stdout,
//       for the owner to put in the Render env and .env as PAYPAL_WEBHOOK_ID. Never commit it.
//   pnpm tsx scripts/setup.ts --list-webhooks      the app's webhooks (url, event count, masked id)
//   pnpm tsx scripts/setup.ts --delete-url <base>  deletes the webhook for that base URL (temporary
//       tunnel webhooks; refuses the Render URL)
//
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and RENDER_WEB_URL) from the environment; never prints
// them. `--record` writes the scrubbed exchanges to fixtures/paypal/webhooks/setup/.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createPayPalWebhooksClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  setupAppWebhook,
  VENDOR_TIMEOUTS_MS,
  webhookUrlFor,
} from "../packages/adapters/src/index.ts";
import { createRecorder } from "../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../packages/adapters/src/testing/scrub.ts";

/** Non-secret default (`.env.example`, M0-08). */
const DEFAULT_RENDER_WEB_URL = "https://cleared-web-gd1b.onrender.com";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing ${name} in the environment`);
  return v;
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const mask = (id: string): string => `…${id.slice(-4)}`;

async function main(): Promise<void> {
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const tokensSeen = new Set<string>();
  const recorder = process.argv.includes("--record")
    ? createRecorder({
        dir: fileURLToPath(new URL("../fixtures/paypal/webhooks/", import.meta.url)),
        ticket: "M1-04",
        scrubber: createScrubber({
          secrets: () => [credentials.clientId, credentials.clientSecret, ...tokensSeen],
        }),
      })
    : undefined;
  let calls = 0;
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      calls += 1;
      recorder?.onExchange(e);
    },
  });
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials,
    cache: new Map(),
  });
  recorder?.label("setup/token");
  tokensSeen.add((await tokens.getToken()).value);
  const wh = createPayPalWebhooksClient({ http, tokens });
  const renderBase = process.env["RENDER_WEB_URL"] ?? DEFAULT_RENDER_WEB_URL;

  if (process.argv.includes("--list-webhooks")) {
    recorder?.label("setup/list");
    for (const w of await wh.listWebhooks()) {
      console.log(JSON.stringify({ url: w.url, eventTypes: w.event_types.length, id: mask(w.id) }));
    }
    console.error(JSON.stringify({ paypalCalls: calls }));
    return;
  }

  const deleteBase = arg("--delete-url");
  if (deleteBase !== undefined) {
    const url = webhookUrlFor(deleteBase);
    if (url === webhookUrlFor(renderBase)) throw new Error("refusing to delete the Render webhook");
    const hooks = (await wh.listWebhooks()).filter((w) => w.url === url);
    for (const w of hooks) await wh.deleteWebhook(w.id);
    console.log(JSON.stringify({ deleted: hooks.length, url, paypalCalls: calls }));
    return;
  }

  recorder?.label(`setup/${arg("--record-as") ?? "ensure"}`);
  const r = await setupAppWebhook(wh, arg("--url") ?? renderBase);
  const idOut = arg("--id-out");
  if (idOut !== undefined) writeFileSync(idOut, `${r.webhookId}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({
      url: r.url,
      webhook: r.webhook,
      webhookId: idOut === undefined ? r.webhookId : `${mask(r.webhookId)} (written to --id-out)`,
      lookup: r.lookup,
      lookupId: r.lookupId,
      paypalCalls: calls,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
