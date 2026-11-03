// M4-04 E2E support (local only): one demo seller with every judge-path screen populated (a checked proof
// pack, an empty pack, a held payment, a dispute with its draft, a scenario run, three notifications and
// a client acknowledgement link), and the route list the accessibility, target-size and reflow specs walk.
// Everything is seeded the way the M2/M3 specs seed it (support/*.ts); personal data is synthetic.
import { randomUUID } from "node:crypto";
import {
  deadlineAlert,
  disputeOpenedNotification,
  holdOpenedNotification,
  WorkspaceIdSchema,
  type Instant,
} from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace } from "@cleared/db";
import { expect, type Page } from "@playwright/test";
import { seed as seedDispute } from "./disputes.ts";
import { seedHeld } from "./holds.ts";
import { demoSeller, LOGO_LINES, seedChecked, seedPayment } from "./pack-seed.ts";

export type Locale = "en" | "hi";
export type State = "populated" | "empty" | "loading" | "error";
export const STATES: readonly State[] = ["populated", "empty", "loading", "error"];

export interface Journey {
  readonly ws: string;
  readonly paymentId: string;
  readonly packId: string;
  readonly emptyPaymentId: string;
  readonly holdId: string;
  readonly disputeRowId: string;
  readonly scenarioId: string;
  /** `/ack/<token>` path of an active client acknowledgement link */
  readonly ackPath: string;
}

const usd = (amount: string) => ({ amount, currency: "USD" as const });

async function seedNotifications(
  ws: string,
  holdPaymentId: string,
  disputeRowId: string,
  dueDate: Date,
): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    const repo = forWorkspace(db, WorkspaceIdSchema.parse(ws)).notifications;
    const due = dueDate.toISOString() as Instant;
    const reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
    await repo.insertOnce(
      holdOpenedNotification({
        holdId: holdPaymentId,
        paymentId: holdPaymentId,
        amount: usd("64.00"),
        reason: "PENDING_REVIEW",
      }),
    );
    await repo.insertOnce(
      disputeOpenedNotification({ disputeRowId, amount: usd("120.00"), reason, dueDate: due }),
    );
    const alert = deadlineAlert({
      disputeRowId,
      dueDate: due,
      open: true,
      now: new Date().toISOString() as Instant,
      amount: usd("120.00"),
      reason,
    });
    if (alert !== null) await repo.insertOnce(alert);
  } finally {
    await closeDb(db);
  }
}

/** Signs in a fresh demo seller in `locale` and seeds every screen of the judge path. */
export async function seedJourney(page: Page, locale: Locale): Promise<Journey> {
  return seedWorkspace(page, await demoSeller(page, locale));
}

/** Seeds every judge-path screen into workspace `ws` (`page` is signed in to it, on our origin). */
export async function seedWorkspace(page: Page, ws: string): Promise<Journey> {
  const db = createDb(databaseUrl());
  let pack: { paymentId: string; packId: string };
  let empty: { paymentId: string };
  let scenarioId: string;
  try {
    pack = await seedChecked(db, ws, LOGO_LINES);
    empty = await seedPayment(db, ws, "45.00");
    const run = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).scenarioRuns.insert({
      state: "capturing",
      orderId: null,
      captureId: null,
      disputeId: null,
      pollStartedAt: null,
      lastPolledAt: null,
      decisionRequestedAt: null,
      finishedAt: null,
      failure: null,
      steps: {},
    });
    scenarioId = run.id;
  } finally {
    await closeDb(db);
  }
  const hold = await seedHeld(ws);
  // one due date for the dispute and its deadline notification (the alert is computed from it)
  const dueDate = new Date(Date.now() + 18 * 3_600_000 + 600_000);
  const dispute = await seedDispute(ws, { dueDate });
  await seedNotifications(ws, hold.paymentId, dispute.disputeRowId, dueDate);
  const res = await page.request.post(`/api/packs/${pack.packId}/ack-links`, {
    headers: { origin: new URL(page.url()).origin, "idempotency-key": randomUUID() },
    data: {},
  });
  expect(res.status(), "the ack link is created").toBe(201);
  const ackPath = new URL(((await res.json()) as { url: string }).url).pathname;
  return {
    ws,
    paymentId: pack.paymentId,
    packId: pack.packId,
    emptyPaymentId: empty.paymentId,
    holdId: hold.holdId,
    disputeRowId: dispute.disputeRowId,
    scenarioId,
    ackPath,
  };
}

export interface Screen {
  readonly name: string;
  /** path without the locale prefix */
  readonly path: (j: Journey) => string;
  /** what the populated screen shows once loaded */
  readonly ready: string;
  /** the API the screen's data comes from (held for "loading", failed for "error") */
  readonly api?: string;
  /** the screen's own test id for its loading state */
  readonly loading?: string;
  /** a signed-in page: false = public (landing, ack, expired link) */
  readonly signedIn: boolean;
}

/** Every signed-in route of the judge path (payments/[id] redirects to its pack: the pack is checked). */
export const SCREENS: readonly Screen[] = [
  {
    name: "payments",
    path: () => "/payments",
    ready: "payment-row",
    api: "**/api/payments*",
    signedIn: true,
  },
  {
    name: "pack",
    path: (j) => `/payments/${j.paymentId}`,
    ready: "verdict-row",
    api: "**/api/packs/*",
    signedIn: true,
  },
  { name: "holds", path: () => "/holds", ready: "hold-row", api: "**/api/holds", signedIn: true },
  {
    name: "hold-detail",
    path: (j) => `/holds/${j.holdId}`,
    ready: "hold-detail",
    api: "**/api/holds/*",
    signedIn: true,
  },
  { name: "disputes", path: () => "/disputes", ready: "dispute-row", api: "**/api/disputes", signedIn: true },
  {
    name: "dispute-review",
    path: (j) => `/disputes/${j.disputeRowId}`,
    ready: "approval-card",
    api: "**/api/disputes/*",
    signedIn: true,
  },
  {
    name: "scenario",
    path: (j) => `/scenario/${j.scenarioId}`,
    ready: "scenario-timeline",
    api: "**/api/scenarios/*",
    signedIn: true,
  },
  {
    name: "calendar",
    path: () => "/calendar",
    ready: "calendar-area",
    api: "**/api/cash-calendar*",
    signedIn: true,
  },
  { name: "audit", path: () => "/audit", ready: "audit-list", api: "**/api/audit*", signedIn: true },
  {
    name: "notifications",
    path: () => "/notifications",
    ready: "notification",
    api: "**/api/notifications*",
    loading: "notifications-loading",
    signedIn: true,
  },
];

/** Waits until a signed-in screen has drawn its data (no skeleton left). */
export async function screenReady(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).first().waitFor();
  await expect(page.getByTestId("loading")).toHaveCount(0);
  // the calendar's Month view: the engine (loaded at runtime from /vendor) has drawn its grid
  if (testId === "calendar-area") {
    const area = page.getByTestId("calendar-area");
    await expect(area).toHaveAttribute("data-view", /list|month/);
    if ((await area.getAttribute("data-view")) === "month") {
      await expect(page.locator(".cash-bryntum .b-calendar-cell[data-date]").first()).toBeAttached({
        timeout: 60_000,
      });
    }
  }
}

/** Holds every request matching `glob` until the returned release is called. */
export async function holdRequests(page: Page, glob: string, method = "GET"): Promise<() => Promise<void>> {
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(glob, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await gate;
    return route.fallback().catch(() => undefined);
  });
  await firstViewOff(page);
  return async () => {
    release();
    await page.unroute(glob);
    await firstViewOn(page);
  };
}

/**
 * M4-08: data screens render their first view on the server, so a held or failed browser request alone no
 * longer shows the loading or error state. While a helper below is active, page loads ask the local server
 * to render without the first view (as when its read fails); the browser's own request then decides the state.
 */
export async function firstViewOff(page: Page): Promise<void> {
  await page
    .context()
    .addCookies([{ name: FIRST_VIEW_COOKIE, value: "off", domain: "localhost", path: "/" }]);
}

/** Ends `firstViewOff`: page loads render their first view on the server again. */
export async function firstViewOn(page: Page): Promise<void> {
  await page.context().clearCookies({ name: FIRST_VIEW_COOKIE });
}

const FIRST_VIEW_COOKIE = "e2e-first-view"; // src/server/first-view.ts FIRST_VIEW_OFF_COOKIE

/** Fails every request matching `glob` with a 500 and a correlation id, as the API's error shape. */
export async function failRequests(page: Page, glob: string, method = "GET"): Promise<() => Promise<void>> {
  await page.route(glob, (route) =>
    route.request().method() === method
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "x-correlation-id": "e2e-a11y-error" },
          body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
        })
      : route.fallback(),
  );
  await firstViewOff(page);
  return async () => {
    await page.unroute(glob);
    await firstViewOn(page);
  };
}
