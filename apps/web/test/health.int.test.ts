// M1-08 AC (health): /healthz needs nothing; /readyz is 503 with db:false when Postgres is unreachable,
// 503 with worker:false when no worker beat for 2 min (injected clock), and 200 when all are up.
// M3-09 AC 7: 503 with reconcile:false when the last reconcile poll is 30 min old (injected clock).
import { RECONCILE_MAX_AGE_MS } from "@cleared/core";
import { closeDb, createDb, platform } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { GET as healthzGet } from "../app/healthz/route.ts";
import { checkReadiness, HEARTBEAT_MAX_AGE_MS, readyzResponse, within } from "../src/server/readiness.ts";
import { testDb } from "./support/db.ts";
import { dbAvailable } from "./support/db-available.ts";

describe("health probes (no database)", () => {
  // Port 1 on localhost: nothing listens, so every check fails fast (as when Postgres is stopped).
  const down = createDb("postgres://cleared:cleared@127.0.0.1:1/cleared");
  afterAll(async () => {
    await closeDb(down).catch(() => undefined);
  });

  it("/healthz → 200 with the database down", async () => {
    const res = await healthzGet(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
  });

  it("/readyz → 503 with db:false (and queue/worker false) when Postgres is unreachable", async () => {
    const res = await readyzResponse({ db: down, now: () => new Date() });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: false,
      checks: { db: false, queue: false, worker: false, reconcile: false },
    });
  });

  it("each check gives up after its timeout", async () => {
    const started = Date.now();
    expect(await within(() => new Promise(() => undefined), 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await within(() => Promise.resolve(1), 50)).toBe(true);
    expect(await within(() => Promise.reject(new Error("x")), 50)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("/readyz (integration)", () => {
  const workerId = `test-m1-08-${String(process.pid)}`;

  /** A reconcile tick stored at `at` (what the worker's `ops.reconcile` writes, M3-09). */
  const reconciled = (db: ReturnType<typeof testDb>, at: Date) =>
    platform(db).opsChecks.insert([{ runAt: at, check: "reconcile", value: 0, target: null, pass: true }]);

  it("200 when db, queue, a fresh worker heartbeat and a recent reconcile are all up", async () => {
    const db = testDb();
    const at = new Date();
    await platform(db).workerHeartbeats.beat(workerId, at);
    await reconciled(db, at);
    const res = await readyzResponse({ db, now: () => new Date(at.getTime() + 1_000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      checks: { db: true, queue: true, worker: true, reconcile: true },
    });
  });

  it("M3-09 AC 7: 503 with reconcile:false when the last reconcile is 30 min old (injected clock)", async () => {
    const db = testDb();
    const at = new Date();
    await reconciled(db, at);
    const last = (await platform(db).opsChecks.latest("reconcile"))?.runAt.getTime() ?? at.getTime();
    const stale = new Date(last + RECONCILE_MAX_AGE_MS);
    // the worker is still beating: only the reconcile check fails
    await platform(db).workerHeartbeats.beat(workerId, stale);
    const res = await readyzResponse({ db, now: () => stale });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: { db: true, queue: true, worker: true, reconcile: false },
    });
    const fresh = await checkReadiness({ db, now: () => new Date(last + RECONCILE_MAX_AGE_MS - 1_000) });
    expect(fresh.checks.reconcile).toBe(true);
  });

  it("503 with worker:false when the newest beat is 2 min old (injected clock)", async () => {
    const db = testDb();
    const at = new Date();
    await platform(db).workerHeartbeats.beat(workerId, at);
    const latest = await platform(db).workerHeartbeats.latest();
    const newest = latest?.beatAt.getTime() ?? at.getTime();
    const r = await checkReadiness({ db, now: () => new Date(newest + HEARTBEAT_MAX_AGE_MS) });
    expect(r.checks).toMatchObject({ db: true, queue: true, worker: false });
    expect(r.ok).toBe(false);
    const almost = await checkReadiness({ db, now: () => new Date(newest + HEARTBEAT_MAX_AGE_MS - 1_000) });
    expect(almost.checks.worker).toBe(true);
  });
});
