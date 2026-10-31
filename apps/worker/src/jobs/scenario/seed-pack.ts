// `scenario.seed_pack` (M2-10 step 2): the payment's proof pack gets the canned synthetic evidence set
// (fixtures/scenario/: the scope chat, the delivery PDF, the client's acceptance message) through the M2-01
// intake path (`writeEvidence`: sniff, caps, re-encode, sha256, blob, `evidence.added`), all in this job's
// transaction with the run's next state and the chargeback job. The bytes never change, so every run
// hashes the same and later AI steps hit the content-hash cache after the first run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIdSchema, type SellerEvidenceKind, type WorkspaceId } from "@cleared/core";
import {
  createPostgresBlobStore,
  evidenceSha256,
  prepareEvidenceFile,
  writeEvidence,
  type NewEvidence,
} from "@cleared/adapters/files";
import { forWorkspace, SCENARIO_CHARGEBACK_QUEUE } from "@cleared/db";
import type { ConsumeContext, Handler } from "../../consume.ts";
import {
  enqueueStep,
  lockForStep,
  runs,
  ScenarioJobSchema,
  type ScenarioDeps,
  type ScenarioJob,
  type StepOutcome,
} from "./shared.ts";

/** The repo's `fixtures/scenario/` (synthetic; the worker runs from the repo checkout). */
export const SCENARIO_FIXTURES_DIR = fileURLToPath(
  new URL("../../../../../fixtures/scenario/", import.meta.url),
);

type CannedItem =
  | { readonly kind: SellerEvidenceKind; readonly file: string; readonly type: "text" }
  | { readonly kind: SellerEvidenceKind; readonly file: string; readonly type: "file" };

export const SCENARIO_EVIDENCE: readonly CannedItem[] = [
  { kind: "scope", file: "scope-chat.txt", type: "text" },
  { kind: "delivery", file: "delivery.pdf", type: "file" },
  { kind: "communication", file: "acceptance.txt", type: "text" },
];

async function prepare(item: CannedItem): Promise<NewEvidence> {
  const bytes = new Uint8Array(readFileSync(`${SCENARIO_FIXTURES_DIR}${item.file}`));
  if (item.type === "text") {
    const text = new TextDecoder().decode(bytes);
    return { type: "text", kind: item.kind, text, sha256: evidenceSha256({ kind: "text", text }) };
  }
  const prepared = await prepareEvidenceFile(bytes);
  if (!prepared.ok) throw new Error(`canned evidence ${item.file} refused: ${prepared.error.code}`);
  return { type: "file", kind: item.kind, file: prepared.value };
}

async function packFor(deps: ScenarioDeps, ws: WorkspaceId, captureId: string, ctx: ConsumeContext) {
  const repos = forWorkspace(deps.db, ws);
  const payment = await repos.payments.getByCaptureId(captureId, ctx.tx);
  if (payment === null) throw new Error(`scenario capture ${captureId} has no payment row yet`);
  return (
    (await repos.proofPacks.getByPaymentId(payment.id, ctx.tx)) ??
    (await repos.proofPacks.insert({ paymentId: payment.id }, ctx.tx))
  );
}

export async function runSeedPackStep(
  deps: ScenarioDeps,
  job: ScenarioJob,
  ctx: ConsumeContext,
): Promise<StepOutcome> {
  const locked = await lockForStep(deps, job, "seed_pack", ctx);
  if (locked === null) return "skipped";
  const { run, steps, next } = locked;
  if (run.captureId === null) throw new Error(`scenario ${run.id} is seeding without a capture`);
  const ws = WorkspaceIdSchema.parse(job.workspaceId);
  const pack = await packFor(deps, ws, run.captureId, ctx);
  const intake = {
    db: deps.db,
    blobs: createPostgresBlobStore(deps.db),
    publisher: deps.publisher,
    now: deps.now,
  };
  const ids: string[] = [];
  for (const item of SCENARIO_EVIDENCE) {
    const row = await writeEvidence(intake, ctx.tx, ws, pack.id, await prepare(item));
    ids.push(row.id);
  }
  const now = deps.now();
  await runs(deps, job).update(
    run.id,
    {
      state: next,
      steps: { ...steps, seed_pack: { at: now.toISOString(), packId: pack.id, evidenceItemIds: ids } },
      updatedAt: now,
    },
    ctx.tx,
  );
  await enqueueStep(deps, ctx, SCENARIO_CHARGEBACK_QUEUE, job);
  ctx.log.info({ scenarioId: run.id, packId: pack.id, items: ids.length }, "scenario pack seeded");
  return "done";
}

export function scenarioSeedPackHandler(deps: ScenarioDeps): Handler {
  return async (data, ctx) => {
    await runSeedPackStep(deps, ScenarioJobSchema.parse(data), ctx);
  };
}
