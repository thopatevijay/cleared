// `sandbox.test_payment` (M1-04) over its sandbox recording: the order's owner row is committed (visible
// to another connection) before the card is confirmed and captured; an unknown workspace is refused
// before any PayPal call.
import { randomUUID } from "node:crypto";
import {
  createHttpClient,
  createPayPalOrdersClient,
  createTokenProvider,
  type PayPalOrdersClient,
} from "@cleared/adapters";
import { closeDb, createDb, platform } from "@cleared/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../packages/adapters/src/testing/fixture.ts";
import { startReplay, type Replay } from "../../../../packages/adapters/src/testing/replay.ts";
import { runTestPayment } from "../../src/jobs/test-payment.ts";
import { dbAvailable, url } from "../helpers.ts";

const T = "paypal/orders/test-payment";
const db = createDb(url);
const observer = createDb(url);
let replay: Replay | undefined;

function orders(): PayPalOrdersClient {
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0 });
  const tokens = createTokenProvider({
    http,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "test-client", clientSecret: "test-secret" },
    cache: new Map(),
  });
  return createPayPalOrdersClient({ http, tokens });
}

describe.skipIf(!dbAvailable)("sandbox.test_payment (test-payment)", () => {
  afterEach(() => {
    replay?.close();
    replay = undefined;
  });
  afterAll(async () => {
    await closeDb(db);
    await closeDb(observer);
  });

  it("claims the order (committed) before confirming and capturing; returns the capture", async () => {
    const create = loadFixture(`${T}/create`);
    const requestId = create.request.headers["paypal-request-id"] ?? "";
    const wsId =
      (create.request.body as { purchase_units: { custom_id: string }[] }).purchase_units[0]?.custom_id ?? "";
    await db.$client.query("delete from paypal_resource_owner where resource_id = '662632381Y533430H'");
    if ((await platform(db).workspaces.get(wsId)) === null) {
      await platform(db).workspaces.create({
        id: wsId,
        kind: "demo",
        locale: "en",
        timezone: "UTC",
        baseCurrency: "USD",
      });
    }
    replay = startReplay(["paypal/oauth/token-m1-04", `${T}/create`, `${T}/confirm`, `${T}/capture`]);
    const real = orders();
    const ownerAtConfirm: (string | null)[] = [];
    const spy: PayPalOrdersClient = {
      ...real,
      confirmCard: async (...a) => {
        const row = await platform(observer).resourceOwners.get("order", a[0]);
        ownerAtConfirm.push(row?.workspaceId ?? null);
        return real.confirmCard(...a);
      },
    };
    const out = await runTestPayment({ db, orders: spy }, { workspaceId: wsId }, requestId);
    expect(out).toEqual({
      orderId: "662632381Y533430H",
      captureId: "2FB27654CR016344S",
      status: "COMPLETED",
    });
    expect(ownerAtConfirm).toEqual([wsId]);
    expect(replay.unused()).toEqual([]);
  });

  it("an unknown workspace is refused before any PayPal call", async () => {
    replay = startReplay([]);
    await expect(
      runTestPayment({ db, orders: orders() }, { workspaceId: randomUUID() }, randomUUID()),
    ).rejects.toThrow(/does not exist/);
    expect(replay.unmatched()).toEqual([]);
  });
});
