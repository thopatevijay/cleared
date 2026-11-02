// M3-10: "Try as demo seller" (POST /api/demo) assigns the new workspace one held judge-pool payment in its
// creating transaction (owner rows moved, `pool.assigned` audited); the held-money inbox then lists it. With
// none available, `GET /api/holds` says `reviewPool: "none"` (the badged explainer); sellers get null.
// Each test runs at its own past `now` (inside the demo window), so the 20 h assignment window only sees the
// rows it seeded, never a live pool's or another test's.
import { randomInt } from "node:crypto";
import type { WorkspaceId } from "@cleared/core";
import { platform } from "@cleared/db";
import { describe, expect, it } from "vitest";
import { ipHash } from "../src/server/client-ip.ts";
import { postDemo } from "../src/server/handlers/demo.ts";
import { listHolds } from "../src/server/holds/read.ts";
import { freshIp, req, testDb, testDeps } from "./support/db.ts";
import { dbAvailable } from "./support/db-available.ts";
import { seedPoolHold } from "./support/pool-seed.ts";

const HOUR = 3_600_000;
const pastNow = () => new Date(Date.UTC(2024, 0, 1) + randomInt(0, 15_000) * HOUR);

async function demoAt(now: Date): Promise<string> {
  const deps = testDeps({ now: () => now });
  const ip = freshIp();
  const res = await postDemo(req("/api/demo", { ip }), deps);
  expect(res.status).toBe(201);
  const r = await testDb().$client.query<{ id: string }>(
    "select id from workspaces where created_ip_hash = $1",
    [ipHash(ip, deps.config.sessionSecret)],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error("no demo workspace");
  return id;
}

describe.skipIf(!dbAvailable)("review-hold pool assignment on demo creation (integration)", () => {
  it("a new demo workspace gets the held judge-pool payment; the next one gets none and the explainer", async () => {
    const db = testDb();
    const now = pastNow();
    const seeded = await seedPoolHold(db, { capturedAt: new Date(now.getTime() - 2 * HOUR) });
    const first = await demoAt(now);
    const row = await platform(db).reviewHoldPool.assignedTo(first);
    expect(row?.captureId).toBe(seeded.captureId);
    const owner = await platform(db).resourceOwners.get("capture", seeded.captureId);
    expect([owner?.workspaceId, owner?.transferredFrom]).toEqual([first, seeded.poolWorkspaceId]);
    const audit = await db.$client.query<{ n: number }>(
      "select count(*)::int as n from audit_log where workspace_id = $1 and action = 'pool.assigned'",
      [first],
    );
    expect(audit.rows[0]?.n).toBe(1);
    const deps = testDeps({ now: () => now });
    const holds = await listHolds(deps, first as WorkspaceId);
    expect(holds.workspace.reviewPool).toBe("assigned");
    expect(holds.items.map((h) => [h.captureId, h.reason, h.ruleId])).toEqual([
      [seeded.captureId, "PENDING_REVIEW", "payment_review"],
    ]);

    const second = await demoAt(now);
    expect(await platform(db).reviewHoldPool.assignedTo(second)).toBeNull();
    const empty = await listHolds(deps, second as WorkspaceId);
    expect([empty.items.length, empty.workspace.reviewPool]).toEqual([0, "none"]);
  });

  it("a judge-pool payment 20 h old is not assigned; a seller workspace has no pool state", async () => {
    const db = testDb();
    const now = pastNow();
    const old = await seedPoolHold(db, { capturedAt: new Date(now.getTime() - 20 * HOUR) });
    const ws = await demoAt(now);
    expect(await platform(db).reviewHoldPool.assignedTo(ws)).toBeNull();
    expect((await platform(db).resourceOwners.get("capture", old.captureId))?.workspaceId).toBe(
      old.poolWorkspaceId,
    );
    const seller = await listHolds(testDeps(), old.poolWorkspaceId as WorkspaceId);
    expect(seller.workspace.reviewPool).toBeNull();
  });
});
