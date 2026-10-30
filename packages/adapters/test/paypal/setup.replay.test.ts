// `scripts/setup.ts` logic (`setupAppWebhook`) over recorded webhook-management exchanges (M1-04 AC:
// run twice → exactly one webhook for the URL). M0-06's recording covers the create-then-no-op path on
// its tunnel URL; the M1-04 recording (fixtures/paypal/webhooks/setup/) is the live run on the Render URL.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/http/client.ts";
import { FIXTURES_DIR, loadFixture } from "../../src/testing/fixture.ts";
import { startReplay, type Replay } from "../../src/testing/replay.ts";
import { setupAppWebhook, webhookUrlFor } from "../../src/paypal/webhook-ingest.ts";
import { createPayPalWebhooksClient, WEBHOOK_EVENT_TYPES } from "../../src/paypal/webhooks.ts";
import { createTokenProvider } from "../../src/paypal/token.ts";

let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

function client(names: string[]) {
  replay = startReplay(names);
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0 });
  const tokens = createTokenProvider({
    http,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "replay", clientSecret: "replay" },
    cache: new Map(),
  });
  return createPayPalWebhooksClient({ http, tokens });
}

const M = "paypal/webhooks/management";
const RENDER = "https://cleared-web-gd1b.onrender.com";

describe("setupAppWebhook", () => {
  it("builds the route URL from a base URL and refuses http", () => {
    expect(webhookUrlFor(`${RENDER}/anything?x=1`)).toBe(`${RENDER}/api/webhooks/paypal`);
    expect(() => webhookUrlFor("http://localhost:3000")).toThrow(/https/);
  });

  it("twice on the M0-06 recording: created, then unchanged on the same id; lookup kept", async () => {
    const url = (loadFixture(`${M}/ensure-1.2`).request.body as { url: string }).url;
    const wh = client([
      "paypal/oauth/token",
      `${M}/ensure-1`,
      `${M}/ensure-1.2`,
      `${M}/lookup-ensure`,
      `${M}/ensure-2`,
      `${M}/lookup-list`,
      `${M}/list-after-ensure`,
    ]);
    const first = await setupAppWebhook(wh, new URL(url).origin);
    const second = await setupAppWebhook(wh, new URL(url).origin);
    expect([first.webhook, second.webhook]).toEqual(["created", "unchanged"]);
    expect(second.webhookId).toBe(first.webhookId);
    expect([first.lookup, second.lookup]).toEqual(["unchanged", "unchanged"]);
    expect(first.lookupId).toBe("9AA71399651744351");
    const hooks = (await wh.listWebhooks()).filter((w) => w.url === url);
    expect(hooks.map((w) => w.id)).toEqual([first.webhookId]);
    expect(replay?.unused()).toEqual([]);
  });

  const live = `${FIXTURES_DIR}paypal/webhooks/setup/run-1.json`;
  it.skipIf(!existsSync(live))(
    "twice on the M1-04 live recording for the Render URL: exactly one webhook",
    async () => {
      const S = "paypal/webhooks/setup";
      const wh = client([
        `${S}/token`,
        `${S}/run-1`,
        `${S}/run-1.2`,
        `${S}/run-1.3`,
        `${S}/run-2`,
        `${S}/run-2.2`,
      ]);
      const first = await setupAppWebhook(wh, RENDER);
      const second = await setupAppWebhook(wh, RENDER);
      expect(first.url).toBe(`${RENDER}/api/webhooks/paypal`);
      expect(first.webhook).toBe("created");
      expect(second.webhook).toBe("unchanged");
      expect(second.webhookId).toBe(first.webhookId);
      const created = loadFixture(`${S}/run-1.2`).response.body as { event_types: { name: string }[] };
      expect(created.event_types.map((e) => e.name).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
    },
  );
});
