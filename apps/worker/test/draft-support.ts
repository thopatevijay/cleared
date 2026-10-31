// M2-07 test support: the sample pack (the synthetic M0-07 logo pack, stored as M2-01 stores it) checked by
// M2-04's own recorded check_scope@v1 answers, and the sample dispute (the M0-05 sandbox chargeback, served from
// its recorded GETs with a fresh id) linked to the pack's payment.
import { randomUUID } from "node:crypto";
import { createHttpClient, createOpenAiCompletionProvider } from "@cleared/adapters";
import { startReplay } from "@cleared/adapters/testing/replay";
import { parseAgentConfig, type Instant, type WorkspaceId } from "@cleared/core";
import { createPublisher, forWorkspace, withTransaction, type Db, type Queue } from "@cleared/db";
import type { SetupServer } from "msw/node";
import { checkScope } from "../src/jobs/check-scope.ts";
import { newPack, newWorkspace, silentLog } from "./extract-support.ts";
import { disputesClient, freshIds, RECORDED_DUE, serveDispute, STATE, type Ids } from "./disputes-support.ts";
import { extractedEvent, SPIKE_PACKS, storePack } from "./scope-support.ts";

/** Before the recorded due date (2026-11-09T04:59:59Z) minus the 1 h margin: the gate passes on any day. */
export const DRAFT_NOW = new Date("2026-10-31T12:00:00.000Z");

export interface SamplePack {
  readonly ws: WorkspaceId;
  readonly packId: string;
  readonly paymentId: string;
  /** item ids, index i is block ref E{i+1} */
  readonly itemIds: readonly string[];
}

/** The logo sample pack, scope-checked with the recorded `scope-v1/logo-pass{1,2}` answers (version 1). */
export async function checkedSamplePack(db: Db, boss: Queue, budget?: string): Promise<SamplePack> {
  const ws = await newWorkspace(db, budget);
  const packId = await newPack(db, ws);
  const itemIds = await storePack(db, ws, packId, SPIKE_PACKS.logo);
  const replay = startReplay(["openai/scope-v1/logo-pass1", "openai/scope-v1/logo-pass2"]);
  try {
    const out = await withTransaction(db, (tx) =>
      checkScope(
        {
          db,
          publisher: createPublisher(db, boss),
          provider: createOpenAiCompletionProvider({
            apiKey: "replay",
            http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
          }),
          config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000 },
          now: () => new Date(),
        },
        extractedEvent(ws, packId, itemIds.at(-1) ?? ""),
        {
          tx,
          log: silentLog,
          envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: null },
        },
      ),
    );
    if (out.status !== "written") throw new Error(`sample pack check: ${out.status}`);
  } finally {
    replay.close();
  }
  const pack = await forWorkspace(db, ws).proofPacks.get(packId);
  if (!pack) throw new Error("sample pack vanished");
  return { ws, packId, paymentId: pack.paymentId, itemIds };
}

export type DisputeState = keyof typeof STATE;

/** Mirrors the sample dispute (fresh ids) on the pack's payment, as M2-06's sync leaves it. */
export async function sampleDispute(
  db: Db,
  pack: SamplePack,
  state: Extract<DisputeState, "waiting" | "underReview">,
): Promise<{ ids: Ids; rowId: string }> {
  const ids = freshIds();
  const waiting = state === "waiting";
  const row = await forWorkspace(db, pack.ws).disputes.insert({
    disputeId: ids.disputeId,
    paymentId: pack.paymentId,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    stage: "CHARGEBACK",
    status: waiting ? "WAITING_FOR_SELLER_RESPONSE" : "UNDER_REVIEW",
    allowedActions: waiting ? ["accept_claim", "provide_evidence"] : ["provide_supporting_info"],
    sellerResponseDueDate: waiting ? new Date(RECORDED_DUE) : null,
    amount: "64.00",
    currency: "USD",
    paypalUpdatedAt: new Date("2026-10-29T05:20:34.178Z"),
  });
  return { ids, rowId: row.id };
}

/** The real disputes client on `server`, which serves the recorded GET of `state` once per call here. */
export function serveSampleDispute(
  server: SetupServer,
  ids: Ids,
  ws: string,
  state: DisputeState,
): ReturnType<typeof disputesClient> {
  serveDispute(server, STATE[state], ids, ws);
  return disputesClient(server);
}

export function disputeEvent(ws: WorkspaceId, ids: Ids, status: string) {
  return {
    type: "dispute.status_changed",
    version: 1,
    workspaceId: ws,
    occurredAt: DRAFT_NOW.toISOString() as Instant,
    data: {
      disputeId: ids.disputeId,
      from: "UNDER_REVIEW",
      to: status,
      source: "webhook",
      updateTime: "2026-10-29T05:20:34.178Z" as Instant,
    },
  } as const;
}

export function packCheckedEvent(ws: WorkspaceId, packId: string) {
  return {
    type: "pack.checked",
    version: 1,
    workspaceId: ws,
    occurredAt: DRAFT_NOW.toISOString() as Instant,
    data: { packId, checkedAt: DRAFT_NOW.toISOString() as Instant },
  } as const;
}
