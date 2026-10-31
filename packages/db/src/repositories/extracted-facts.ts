// M2-03: `extracted_facts`, one row per (evidence item, extract prompt version). Insert only: a re-delivered
// `evidence.added` finds the row and writes nothing (`ON CONFLICT DO NOTHING` on the unique key). M2-04 reads
// a pack's facts with `listForPack`; M2-05 shows them.
import { FactsSchema, WorkspaceIdSchema, type Facts, type WorkspaceId } from "@cleared/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor, Tx } from "../tx.ts";
import { evidenceItems, extractedFacts } from "../../schema/index.ts";

export interface NewExtractedFacts {
  readonly evidenceItemId: string;
  /** stored with the item's uuid as every fact's `evidence_item_id` */
  readonly facts: Facts;
  readonly model: string;
  readonly runId: string | null;
  readonly promptVersion: string;
}

export interface ExtractedFactsRow {
  readonly id: string;
  readonly evidenceItemId: string;
  readonly facts: Facts;
  readonly model: string;
  readonly runId: string | null;
  readonly promptVersion: string;
  readonly createdAt: Date;
}

const columns = {
  id: extractedFacts.id,
  evidenceItemId: extractedFacts.evidenceItemId,
  facts: extractedFacts.facts,
  model: extractedFacts.model,
  runId: extractedFacts.runId,
  promptVersion: extractedFacts.promptVersion,
  createdAt: extractedFacts.createdAt,
};

type RawRow = Omit<ExtractedFactsRow, "facts"> & { facts: unknown };

/** The stored jsonb is re-validated on read: a row that is not `facts@v1` is an error, never a guess. */
function toRow(r: RawRow): ExtractedFactsRow {
  return { ...r, facts: FactsSchema.parse(r.facts) };
}

export function extractedFactsRepo(db: Db, workspaceId: WorkspaceId) {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  return {
    /** Inside the caller's transaction. `null` when the row already exists (a re-delivery). */
    async insert(row: NewExtractedFacts, tx: Tx): Promise<{ id: string } | null> {
      const rows = await tx
        .insert(extractedFacts)
        .values({ workspaceId: ws, ...row, facts: FactsSchema.parse(row.facts) })
        .onConflictDoNothing({ target: [extractedFacts.evidenceItemId, extractedFacts.promptVersion] })
        .returning({ id: extractedFacts.id });
      return rows[0] ?? null;
    },

    async forItem(
      evidenceItemId: string,
      promptVersion: string,
      tx?: Executor,
    ): Promise<ExtractedFactsRow | null> {
      const rows = await (tx ?? db)
        .select(columns)
        .from(extractedFacts)
        .where(
          and(
            eq(extractedFacts.workspaceId, ws),
            eq(extractedFacts.evidenceItemId, evidenceItemId),
            eq(extractedFacts.promptVersion, promptVersion),
          ),
        )
        .limit(1);
      const r = rows[0];
      return r ? toRow(r) : null;
    },

    /** Every item's facts in a pack, oldest item first (M2-04 pass 1). */
    async listForPack(packId: string, promptVersion: string, tx?: Executor): Promise<ExtractedFactsRow[]> {
      const rows = await (tx ?? db)
        .select(columns)
        .from(extractedFacts)
        .innerJoin(evidenceItems, eq(evidenceItems.id, extractedFacts.evidenceItemId))
        .where(
          and(
            eq(extractedFacts.workspaceId, ws),
            eq(evidenceItems.workspaceId, ws),
            eq(evidenceItems.packId, packId),
            eq(extractedFacts.promptVersion, promptVersion),
          ),
        )
        .orderBy(asc(evidenceItems.createdAt), asc(evidenceItems.id));
      return rows.map(toRow);
    },
  };
}

export type ExtractedFactsRepo = ReturnType<typeof extractedFactsRepo>;
