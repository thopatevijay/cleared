// AC: with workspaces A and B each holding rows, A's repos never return B's rows (table-driven over
// every workspace-scoped repo).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { forWorkspace, WORKSPACE_REPO_NAMES, type WorkspaceRepos } from "../src/repos/workspace/index.ts";
import { WorkspaceIdSchema } from "@cleared/core";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { newWorkspace, seedGraph, type RepoName } from "./graph.ts";

describe.skipIf(!dbAvailable)("workspace isolation (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  let a: WorkspaceRepos;
  let b: WorkspaceRepos;
  let idsA: Partial<Record<RepoName, string>>;
  let idsB: Partial<Record<RepoName, string>>;

  beforeAll(async () => {
    a = await newWorkspace(db);
    b = await newWorkspace(db);
    idsA = await seedGraph(a);
    idsB = await seedGraph(b);
  });
  afterAll(() => closeDb(db));

  it("the graph covers every workspace-scoped repo", () => {
    expect(Object.keys(idsA).sort()).toEqual([...WORKSPACE_REPO_NAMES].sort());
    expect(Object.keys(idsB).sort()).toEqual([...WORKSPACE_REPO_NAMES].sort());
  });

  describe.each(WORKSPACE_REPO_NAMES)("%s", (name) => {
    it("list() returns A's row and never B's", async () => {
      const rows = await a[name].list({ limit: 500 });
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(idsA[name]);
      expect(ids).not.toContain(idsB[name]);
      expect(rows.every((row) => row.workspaceId === a.workspaceId)).toBe(true);
    });

    it("get(B's id) is not found from A; get(A's id) is found", async () => {
      expect(await a[name].get(idsB[name] ?? "")).toBeNull();
      expect((await a[name].get(idsA[name] ?? ""))?.id).toBe(idsA[name]);
    });
  });

  it("update through A cannot touch B's row, and cannot move a row to another workspace", async () => {
    const paymentB = idsB.payments ?? "";
    expect(await a.payments.update(paymentB, { status: "COMPLETED" })).toBeNull();
    expect((await b.payments.get(paymentB))?.status).toBe("PENDING");
    const sneaky = { status: "PENDING", workspaceId: b.workspaceId } as { status: string };
    const moved = await a.payments.update(idsA.payments ?? "", sneaky);
    expect(moved?.workspaceId).toBe(a.workspaceId);
  });

  it("business-key finders stay inside the workspace", async () => {
    const paymentB = await b.payments.get(idsB.payments ?? "");
    const disputeB = await b.disputes.get(idsB.disputes ?? "");
    expect(await a.payments.getByCaptureId(paymentB?.captureId ?? "")).toBeNull();
    expect(await a.disputes.getByDisputeId(disputeB?.disputeId ?? "")).toBeNull();
    expect(await a.proofPacks.getByPaymentId(idsB.payments ?? "")).toBeNull();
    expect((await b.payments.getByCaptureId(paymentB?.captureId ?? ""))?.id).toBe(idsB.payments);
  });

  it("a non-uuid id is not found, and a non-uuid workspace id is refused", async () => {
    expect(await a.payments.get("not-a-uuid")).toBeNull();
    expect(() => forWorkspace(db, "x" as unknown as ReturnType<typeof WorkspaceIdSchema.parse>)).toThrow();
  });
});
