// M2-04: `scope_checks`, one row per scope line of one check version. Append-only (migration 0009 trigger):
// a re-delivered `pack.extracted` finds its rows by (pack, evidence set hash, prompt version) and writes
// nothing; new evidence writes the next version. Reads re-validate the citation jsonb.
import {
  CLEARED_EVIDENCE_KINDS,
  LINE_NOTES,
  StoredCitationSchema,
  VERDICTS,
  WorkspaceIdSchema,
  type LineNote,
  type StoredCitation,
  type Verdict,
  type WorkspaceId,
} from "@cleared/core";
import { and, asc, desc, eq, exists, not, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.ts";
import type { Executor, Tx } from "../tx.ts";
import { auditLog, evidenceItems, extractedFacts, scopeChecks } from "../../schema/index.ts";

export interface NewScopeLine {
  readonly lineId: string;
  readonly line: string;
  readonly verdict: Verdict;
  readonly modelVerdict: Verdict;
  readonly note: LineNote | null;
  readonly rationale: string;
  readonly lineCitation: StoredCitation | null;
  readonly citations: readonly StoredCitation[];
}

export interface NewScopeCheck {
  readonly packId: string;
  readonly evidenceSetHash: string;
  readonly promptVersion: string;
  readonly runId: string | null;
  readonly lines: readonly NewScopeLine[];
}

export interface ScopeCheckRow extends NewScopeLine {
  readonly id: string;
  readonly packId: string;
  readonly checkVersion: number;
  readonly evidenceSetHash: string;
  readonly promptVersion: string;
  readonly runId: string | null;
  readonly createdAt: Date;
}

const columns = {
  id: scopeChecks.id,
  packId: scopeChecks.packId,
  checkVersion: scopeChecks.checkVersion,
  evidenceSetHash: scopeChecks.evidenceSetHash,
  promptVersion: scopeChecks.promptVersion,
  runId: scopeChecks.runId,
  lineId: scopeChecks.lineId,
  line: scopeChecks.line,
  verdict: scopeChecks.verdict,
  modelVerdict: scopeChecks.modelVerdict,
  note: scopeChecks.note,
  rationale: scopeChecks.rationale,
  lineCitation: scopeChecks.lineCitation,
  citations: scopeChecks.citations,
  createdAt: scopeChecks.createdAt,
};

const Citations = z.array(StoredCitationSchema);
const Note = z.enum(LINE_NOTES).nullable();
const VerdictSchema = z.enum(VERDICTS);

type RawRow = { [K in keyof typeof columns]: unknown } & { createdAt: Date };

function toRow(r: RawRow): ScopeCheckRow {
  return {
    id: z.string().parse(r.id),
    packId: z.string().parse(r.packId),
    checkVersion: z.number().int().parse(r.checkVersion),
    evidenceSetHash: z.string().parse(r.evidenceSetHash),
    promptVersion: z.string().parse(r.promptVersion),
    runId: z.string().nullable().parse(r.runId),
    lineId: z.string().parse(r.lineId),
    line: z.string().parse(r.line),
    verdict: VerdictSchema.parse(r.verdict),
    modelVerdict: VerdictSchema.parse(r.modelVerdict),
    note: Note.parse(r.note),
    rationale: z.string().parse(r.rationale),
    lineCitation: StoredCitationSchema.nullable().parse(r.lineCitation),
    citations: Citations.parse(r.citations),
    createdAt: r.createdAt,
  };
}

/** `C2` before `C10`. */
const byLine = (a: ScopeCheckRow, b: ScopeCheckRow): number =>
  Number(a.lineId.slice(1)) - Number(b.lineId.slice(1)) || a.lineId.localeCompare(b.lineId);

export function scopeChecksRepo(db: Db, workspaceId: WorkspaceId) {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  const inPack = (packId: string) => and(eq(scopeChecks.workspaceId, ws), eq(scopeChecks.packId, packId));

  async function versionRows(packId: string, version: number, ex: Executor): Promise<ScopeCheckRow[]> {
    const rows = await ex
      .select(columns)
      .from(scopeChecks)
      .where(and(inPack(packId), eq(scopeChecks.checkVersion, version)))
      .orderBy(asc(scopeChecks.lineId));
    return rows.map(toRow).sort(byLine);
  }

  /** The check already written for this evidence set and prompt, or `null` (the idempotency pre-check). */
  async function versionFor(
    packId: string,
    evidenceSetHash: string,
    promptVersion: string,
    tx?: Executor,
  ): Promise<number | null> {
    const rows = await (tx ?? db)
      .select({ v: scopeChecks.checkVersion })
      .from(scopeChecks)
      .where(
        and(
          inPack(packId),
          eq(scopeChecks.evidenceSetHash, evidenceSetHash),
          eq(scopeChecks.promptVersion, promptVersion),
        ),
      )
      .limit(1);
    return rows[0]?.v ?? null;
  }

  return {
    versionFor,

    /**
     * Writes the next version (inside the caller's transaction, with the pack row locked so versions are
     * serial). `null` when this evidence set and prompt were already checked (a re-delivery).
     */
    async insertCheck(check: NewScopeCheck, tx: Tx): Promise<{ checkVersion: number; ids: string[] } | null> {
      if ((await versionFor(check.packId, check.evidenceSetHash, check.promptVersion, tx)) !== null)
        return null;
      const [top] = await tx
        .select({ v: sql<number>`coalesce(max(${scopeChecks.checkVersion}), 0)::int` })
        .from(scopeChecks)
        .where(inPack(check.packId));
      const checkVersion = (top?.v ?? 0) + 1;
      const rows = await tx
        .insert(scopeChecks)
        .values(
          check.lines.map((l) => ({
            workspaceId: ws,
            packId: check.packId,
            checkVersion,
            evidenceSetHash: check.evidenceSetHash,
            promptVersion: check.promptVersion,
            runId: check.runId,
            lineId: l.lineId,
            line: l.line,
            verdict: l.verdict,
            modelVerdict: l.modelVerdict,
            note: l.note,
            rationale: l.rationale,
            lineCitation: l.lineCitation === null ? null : StoredCitationSchema.parse(l.lineCitation),
            citations: Citations.parse(l.citations),
          })),
        )
        .onConflictDoNothing()
        .returning({ id: scopeChecks.id });
      return rows.length === 0 ? null : { checkVersion, ids: rows.map((r) => r.id) };
    },

    /** The pack's current check (its newest version), lines in order; [] before the first check. */
    async latestForPack(packId: string, tx?: Executor): Promise<ScopeCheckRow[]> {
      const ex = tx ?? db;
      const [top] = await ex
        .select({ v: scopeChecks.checkVersion })
        .from(scopeChecks)
        .where(inPack(packId))
        .orderBy(desc(scopeChecks.checkVersion))
        .limit(1);
      return top ? versionRows(packId, top.v, ex) : [];
    },

    /** One version's lines (M2-05 history, tests). */
    forVersion(packId: string, version: number, tx?: Executor): Promise<ScopeCheckRow[]> {
      return versionRows(packId, version, tx ?? db);
    },

    /**
     * Items of the pack whose extraction has not finished: no facts row for `extractPrompt` and no
     * `extract.no_facts` audit entry (M2-03). The scope check waits for them. Cleared's own records
     * (`client_ack`, `scope_snapshot`) are never extracted, so nothing waits for them (ADR 0018).
     */
    async itemsAwaitingFacts(packId: string, extractPrompt: string, tx?: Executor): Promise<string[]> {
      const ex = tx ?? db;
      const facts = ex
        .select({ one: sql`1` })
        .from(extractedFacts)
        .where(
          and(
            eq(extractedFacts.evidenceItemId, evidenceItems.id),
            eq(extractedFacts.promptVersion, extractPrompt),
          ),
        );
      const noFacts = ex
        .select({ one: sql`1` })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, ws),
            eq(auditLog.action, "extract.no_facts"),
            sql`${auditLog.detail}->>'evidenceItemId' = ${evidenceItems.id}::text`,
          ),
        );
      const rows = await ex
        .select({ id: evidenceItems.id })
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, ws),
            eq(evidenceItems.packId, packId),
            notInArray(evidenceItems.kind, [...CLEARED_EVIDENCE_KINDS]),
            not(exists(facts)),
            not(exists(noFacts)),
          ),
        )
        .orderBy(asc(evidenceItems.createdAt), asc(evidenceItems.id));
      return rows.map((r) => r.id);
    },
  };
}

export type ScopeChecksRepo = ReturnType<typeof scopeChecksRepo>;
