// M2-09: the dispute read and revise API over a seeded M2-07 draft (recorded draft notes, real compile, real
// guardrail and proposal). Workspace-scoped reads; a seller edit is a new seller proposal with a new hash,
// the superseded one is rejected (audit `superseded`), and approving the old hash afterwards is refused
// APPROVAL_HASH_MISMATCH when sent to the dispute's current proposal; a failed filing can be re-proposed;
// the compiled PDF downloads; over-limit notes are refused. No PayPal or model call.
import { WorkspaceIdSchema } from "@cleared/core";
import {
  actionAuditTrail,
  createPublisher,
  createQueue,
  disputeDraftsRepo,
  forWorkspace,
  getProposedAction,
  setProposedActionState,
  type Publisher,
} from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { postApprove } from "../../../src/server/handlers/actions.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getDispute, getDisputes, getDraftPdf, postRevise } from "../../../src/server/handlers/disputes.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import type { DisputeDetail, DisputeList } from "../../../src/lib/dispute-view.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";
import { recordedNotes, seedDispute } from "../../../test/support/dispute-seed.ts";

const created: string[] = [];
let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

const detail = async (cookie: string, id: string) => {
  const res = await getDispute(req(`/api/disputes/${id}`, { method: "GET", cookie }), testDeps(), id);
  return { status: res.status, body: (await res.json()) as DisputeDetail };
};
const revise = async (cookie: string, id: string, body: unknown) => {
  const res = await postRevise(req(`/api/disputes/${id}/draft/revise`, { cookie, body }), testDeps(), id);
  return {
    status: res.status,
    body: (await res.json()) as {
      action?: { id: string; payload_sha256: string; state: string };
      error?: { details?: { refusal?: string } };
    },
  };
};

describe.skipIf(!dbAvailable)("dispute API (integration)", () => {
  afterAll(async () => {
    const db = testDb();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("GET /api/disputes: the workspace's disputes with the in-dispute total; another workspace sees none", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedDispute(testDb(), a.ws);
    const list = async (cookie: string) =>
      (await (
        await getDisputes(req("/api/disputes", { method: "GET", cookie }), testDeps())
      ).json()) as DisputeList;
    const own = await list(a.cookie);
    expect(own.items).toHaveLength(1);
    expect(own.items[0]).toMatchObject({
      id: s.disputeRowId,
      disputeId: s.paypalDisputeId,
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      amount: { value: "120.00", currency: "USD" },
      draftReady: true,
      payment: { id: s.paymentId, status: "PENDING", statusReason: "BUYER_COMPLAINT" },
    });
    expect(own.summary.inDispute).toEqual([{ value: "120.00", currency: "USD" }]);
    const other = await list(b.cookie);
    expect(other.items).toEqual([]);
    expect(other.summary.inDispute).toEqual([]);
  });

  it("GET /api/disputes/:id: facts, draft (notes, items, PDF, proposal), audit; 404 across workspaces; PayPal id works", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedDispute(testDb(), a.ws);
    const d = await detail(a.cookie, s.disputeRowId);
    expect(d.status).toBe(200);
    expect(d.body.dispute.allowedActions).toEqual(["accept_claim", "provide_evidence"]);
    expect(d.body.draft?.notes).toBe(recordedNotes());
    expect(d.body.draft?.items.map((i) => i.selected)).toEqual([true, true, true]);
    expect(d.body.draft?.action).toMatchObject({
      id: s.actionId,
      state: "proposed",
      payload_sha256: s.payloadSha256,
      createdBy: "agent",
    });
    expect(d.body.draft?.pdf?.bytes).toBeGreaterThan(1000);
    expect(d.body.audit.map((e) => e.action)).toEqual(["action.proposed"]);
    expect((await detail(a.cookie, s.paypalDisputeId)).body.dispute.id).toBe(s.disputeRowId);
    expect((await detail(b.cookie, s.disputeRowId)).status).toBe(404);
    expect((await detail(b.cookie, s.paypalDisputeId)).status).toBe(404);
    const pdf = await getDraftPdf(
      req(`/api/disputes/${s.disputeRowId}/draft/pdf?draft=${s.draftId}`, {
        method: "GET",
        cookie: a.cookie,
      }),
      testDeps(),
      s.disputeRowId,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const foreign = await getDraftPdf(
      req(`/api/disputes/${s.disputeRowId}/draft/pdf?draft=${s.draftId}`, {
        method: "GET",
        cookie: b.cookie,
      }),
      testDeps(),
      s.disputeRowId,
    );
    expect(foreign.status).toBe(404);
  });

  it("deselecting an item makes a new proposal and hash; the old one is superseded; approving the old hash is refused", async () => {
    const a = await demo();
    const s = await seedDispute(testDb(), a.ws);
    const kept = s.itemIds.slice(0, 2);
    const r = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: recordedNotes(),
      evidence_item_ids: kept,
    });
    expect(r.status).toBe(200);
    const next = r.body.action;
    expect(next?.state).toBe("proposed");
    expect(next?.payload_sha256).not.toBe(s.payloadSha256);
    expect((await getProposedAction(testDb(), a.ws, s.actionId))?.state).toBe("rejected");
    const trail = await actionAuditTrail(testDb(), a.ws, s.actionId);
    expect(trail.at(-1)).toMatchObject({
      action: "action.rejected",
      detail: { reason: "superseded", supersededBy: next?.id },
    });
    const draft = (
      await disputeDraftsRepo(testDb(), WorkspaceIdSchema.parse(a.ws)).listForDispute(s.disputeRowId)
    )[0];
    expect(draft?.evidenceItemIds).toEqual(kept);
    expect(draft?.proposedActionId).toBe(next?.id);
    const d = await detail(a.cookie, s.disputeRowId);
    expect(d.body.draft?.action?.createdBy).toBe("seller");
    expect(d.body.draft?.items.map((i) => i.selected)).toEqual([true, true, false]);
    // a stale tab: the old hash against the dispute's current proposal
    const stale = await postApprove(
      req(`/api/actions/${String(next?.id)}/approve`, {
        cookie: a.cookie,
        body: { payload_sha256: s.payloadSha256 },
      }),
      testDeps(),
      publisher,
      String(next?.id),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { details: { refusal: string } } }).error.details.refusal).toBe(
      "APPROVAL_HASH_MISMATCH",
    );
    expect((await getProposedAction(testDb(), a.ws, String(next?.id)))?.state).toBe("proposed");
  });

  it("refuses notes over 2000 characters, an empty selection and items outside the pack", async () => {
    const a = await demo();
    const s = await seedDispute(testDb(), a.ws);
    const long = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: "a".repeat(2001),
      evidence_item_ids: s.itemIds,
    });
    expect(long.status).toBe(422);
    expect(long.body.error?.details?.refusal).toBe("NOTES_TOO_LONG");
    const ok2000 = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: "😀".repeat(2000),
      evidence_item_ids: s.itemIds,
    });
    expect(ok2000.status).toBe(200);
    expect(
      (await revise(a.cookie, s.disputeRowId, { draft_id: s.draftId, notes: "x", evidence_item_ids: [] }))
        .status,
    ).toBe(400);
    const b = await demo();
    const other = await seedDispute(testDb(), b.ws);
    const foreign = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: "x",
      evidence_item_ids: [other.itemIds[0]],
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error?.details?.refusal).toBe("UNKNOWN_EVIDENCE_ITEM");
    expect(
      (
        await revise(b.cookie, s.disputeRowId, {
          draft_id: s.draftId,
          notes: "x",
          evidence_item_ids: s.itemIds,
        })
      ).status,
    ).toBe(404);
  });

  it("an approved filing can't be revised; a failed one is re-proposed (BL-01 6537331741)", async () => {
    const a = await demo();
    const s = await seedDispute(testDb(), a.ws);
    const db = testDb();
    await setProposedActionState(db, a.ws, s.actionId, { from: "proposed", to: "approved" });
    const blocked = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: "x",
      evidence_item_ids: s.itemIds,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.refusal).toBe("ACTION_NOT_PROPOSED");
    await setProposedActionState(db, a.ws, s.actionId, { from: "approved", to: "executing" });
    await setProposedActionState(db, a.ws, s.actionId, {
      from: "executing",
      to: "failed",
      refusalCode: "PAYPAL_UNAVAILABLE",
    });
    const again = await revise(a.cookie, s.disputeRowId, {
      draft_id: s.draftId,
      notes: recordedNotes(),
      evidence_item_ids: s.itemIds,
    });
    expect(again.status).toBe(200);
    expect(again.body.action?.state).toBe("proposed");
    expect((await getProposedAction(db, a.ws, s.actionId))?.state).toBe("failed");
  });

  it("the stale supporting-info draft is hidden behind the newer allowed evidence draft (BL-01 6538667356)", async () => {
    const a = await demo();
    const s = await seedDispute(testDb(), a.ws, { allowed: ["accept_claim", "provide_evidence"] });
    const repos = forWorkspace(testDb(), WorkspaceIdSchema.parse(a.ws));
    // an older supporting-info draft still `proposed`, written before the links changed
    const old = await repos.proposedActions.insert({
      kind: "provide_supporting_info",
      payload: { dispute_id: s.paypalDisputeId, notes: "older" },
      payloadSha256: "e".repeat(64),
      state: "proposed",
      risk: "high",
    });
    await repos.disputeDrafts.insert({
      disputeId: s.disputeRowId,
      notes: "older supporting info",
      actionKind: "provide_supporting_info",
      checkVersion: 0,
      proposedActionId: old.id,
      createdAt: new Date(Date.now() + 60_000),
    } as never);
    const d = await detail(a.cookie, s.disputeRowId);
    expect(d.body.draft?.id).toBe(s.draftId);
    expect(d.body.draft?.actionKind).toBe("provide_evidence");
  });
});
