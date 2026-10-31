// M2-05: the proof-pack read model behind the pack page and the dashboard rows. One batch of queries per
// page of payments (never one query per row): the packs, their items, how each item's extraction ended,
// the newest `check_unavailable` entry and the latest check's verdicts. Bound to one workspace.
import {
  EXTRACT_PROMPT,
  WorkspaceIdSchema,
  type PackState,
  type Verdict,
  type WorkspaceId,
} from "@cleared/core";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor } from "../tx.ts";
import { auditLog, evidenceItems, extractedFacts, proofPacks, scopeChecks } from "../../schema/index.ts";

export interface PackStatusLine {
  readonly verdict: Verdict;
  readonly lineCitation: { readonly evidence_item_id: string } | null;
  readonly citations: readonly { readonly evidence_item_id: string }[];
}

export interface PackStatus {
  readonly packId: string;
  readonly paymentId: string;
  readonly state: PackState;
  readonly checkedAt: Date | null;
  /** evidence kinds, oldest item first */
  readonly kinds: readonly string[];
  readonly newestItemAt: Date | null;
  readonly unavailable: { readonly at: Date; readonly status: string } | null;
  /** set when every item finished extraction and the last to finish ended without facts */
  readonly lastExtractionFailed: { readonly at: Date; readonly status: string } | null;
  /** the latest check's lines (citations reduced to their item ids); [] before the first check */
  readonly latest: readonly PackStatusLine[];
}

const CHECK_UNAVAILABLE = "check_unavailable";
const NO_FACTS = "extract.no_facts";

interface Finish {
  readonly at: Date;
  readonly ok: boolean;
  readonly status: string;
}

const ItemRef = (v: unknown): { evidence_item_id: string } | null =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { evidence_item_id?: unknown }).evidence_item_id === "string"
    ? { evidence_item_id: (v as { evidence_item_id: string }).evidence_item_id }
    : null;

function lastFailure(itemIds: readonly string[], finishes: ReadonlyMap<string, Finish>): Finish | null {
  let last: Finish | null = null;
  for (const id of itemIds) {
    const f = finishes.get(id);
    if (f === undefined) return null; // still extracting: the check will run when it finishes
    if (last === null || f.at.getTime() >= last.at.getTime()) last = f;
  }
  return last !== null && !last.ok ? last : null;
}

export function packReadsRepo(db: Db, workspaceId: WorkspaceId) {
  const ws = WorkspaceIdSchema.parse(workspaceId);

  async function itemFinishes(itemIds: readonly string[], ex: Executor): Promise<Map<string, Finish>> {
    const out = new Map<string, Finish>();
    if (itemIds.length === 0) return out;
    const failed = await ex
      .select({
        itemId: sql<string>`${auditLog.detail}->>'evidenceItemId'`,
        at: auditLog.at,
        status: sql<string>`coalesce(${auditLog.detail}->>'status', 'failed')`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, ws),
          eq(auditLog.action, NO_FACTS),
          inArray(sql`${auditLog.detail}->>'evidenceItemId'`, [...itemIds]),
        ),
      )
      .orderBy(asc(auditLog.at));
    for (const f of failed) out.set(f.itemId, { at: f.at, ok: false, status: f.status });
    const facts = await ex
      .select({ itemId: extractedFacts.evidenceItemId, at: extractedFacts.createdAt })
      .from(extractedFacts)
      .where(
        and(
          eq(extractedFacts.workspaceId, ws),
          eq(extractedFacts.promptVersion, EXTRACT_PROMPT.id),
          inArray(extractedFacts.evidenceItemId, [...itemIds]),
        ),
      );
    // a facts row means the item finished well, even after an earlier failed run
    for (const f of facts) out.set(f.itemId, { at: f.at, ok: true, status: "succeeded" });
    return out;
  }

  async function latestLines(
    packIds: readonly string[],
    ex: Executor,
  ): Promise<Map<string, PackStatusLine[]>> {
    const out = new Map<string, PackStatusLine[]>();
    if (packIds.length === 0) return out;
    const top = ex
      .select({ packId: scopeChecks.packId, v: sql<number>`max(${scopeChecks.checkVersion})`.as("v") })
      .from(scopeChecks)
      .where(and(eq(scopeChecks.workspaceId, ws), inArray(scopeChecks.packId, [...packIds])))
      .groupBy(scopeChecks.packId)
      .as("top");
    const rows = await ex
      .select({
        packId: scopeChecks.packId,
        verdict: scopeChecks.verdict,
        lineCitation: scopeChecks.lineCitation,
        citations: scopeChecks.citations,
      })
      .from(scopeChecks)
      .innerJoin(top, and(eq(scopeChecks.packId, top.packId), eq(scopeChecks.checkVersion, top.v)))
      .where(eq(scopeChecks.workspaceId, ws));
    for (const r of rows) {
      const list = out.get(r.packId) ?? [];
      const cites = Array.isArray(r.citations) ? r.citations.map(ItemRef).filter((c) => c !== null) : [];
      list.push({ verdict: r.verdict, lineCitation: ItemRef(r.lineCitation), citations: cites });
      out.set(r.packId, list);
    }
    return out;
  }

  async function statusOf(
    packs: readonly { id: string; paymentId: string; state: PackState; checkedAt: Date | null }[],
    ex: Executor,
  ): Promise<PackStatus[]> {
    if (packs.length === 0) return [];
    const ids = packs.map((p) => p.id);
    const items = await ex
      .select({
        id: evidenceItems.id,
        packId: evidenceItems.packId,
        kind: evidenceItems.kind,
        at: evidenceItems.createdAt,
      })
      .from(evidenceItems)
      .where(and(eq(evidenceItems.workspaceId, ws), inArray(evidenceItems.packId, ids)))
      .orderBy(asc(evidenceItems.createdAt), asc(evidenceItems.id));
    const unavailable = await ex
      .select({
        packId: sql<string>`${auditLog.detail}->>'packId'`,
        at: auditLog.at,
        status: sql<string>`coalesce(${auditLog.detail}->>'status', 'failed')`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, ws),
          eq(auditLog.action, CHECK_UNAVAILABLE),
          inArray(sql`${auditLog.detail}->>'packId'`, ids),
        ),
      )
      .orderBy(desc(auditLog.at));
    const [finishes, lines] = await Promise.all([
      itemFinishes(
        items.map((i) => i.id),
        ex,
      ),
      latestLines(ids, ex),
    ]);
    return packs.map((p) => {
      const own = items.filter((i) => i.packId === p.id);
      const u = unavailable.find((x) => x.packId === p.id);
      return {
        packId: p.id,
        paymentId: p.paymentId,
        state: p.state,
        checkedAt: p.checkedAt,
        kinds: own.map((i) => i.kind),
        newestItemAt: own.at(-1)?.at ?? null,
        unavailable: u === undefined ? null : { at: u.at, status: u.status },
        lastExtractionFailed: (() => {
          const f = lastFailure(
            own.map((i) => i.id),
            finishes,
          );
          return f === null ? null : { at: f.at, status: f.status };
        })(),
        latest: lines.get(p.id) ?? [],
      };
    });
  }

  const packColumns = {
    id: proofPacks.id,
    paymentId: proofPacks.paymentId,
    state: proofPacks.state,
    checkedAt: proofPacks.checkedAt,
  };

  return {
    /** The packs of these payments (a payment without a pack has no entry). */
    async forPayments(paymentIds: readonly string[], tx?: Executor): Promise<Map<string, PackStatus>> {
      const ex = tx ?? db;
      if (paymentIds.length === 0) return new Map();
      const packs = await ex
        .select(packColumns)
        .from(proofPacks)
        .where(and(eq(proofPacks.workspaceId, ws), inArray(proofPacks.paymentId, [...paymentIds])));
      const status = await statusOf(packs, ex);
      return new Map(status.map((st) => [st.paymentId, st]));
    },

    /** One pack of this workspace, or null (foreign and unknown look the same). */
    async forPack(packId: string, tx?: Executor): Promise<PackStatus | null> {
      const ex = tx ?? db;
      const packs = await ex
        .select(packColumns)
        .from(proofPacks)
        .where(and(eq(proofPacks.workspaceId, ws), eq(proofPacks.id, packId)))
        .limit(1);
      const [status] = await statusOf(packs, ex);
      return status ?? null;
    },

    /** dashboard.md 3c: packs checked (or marked ready) whose latest check has no `missing` line. */
    async proofReadyCount(tx?: Executor): Promise<number> {
      const rows = await (tx ?? db)
        .select({ n: count() })
        .from(proofPacks)
        .where(
          and(
            eq(proofPacks.workspaceId, ws),
            inArray(proofPacks.state, ["checked", "ready"]),
            sql`not exists (
              select 1 from ${scopeChecks} sc
              where sc.workspace_id = ${ws} and sc.pack_id = ${proofPacks.id} and sc.verdict = 'missing'
                and sc.check_version = (
                  select max(x.check_version) from ${scopeChecks} x
                  where x.workspace_id = ${ws} and x.pack_id = ${proofPacks.id}
                )
            )`,
          ),
        );
      return rows[0]?.n ?? 0;
    },
  };
}

export type PackReadsRepo = ReturnType<typeof packReadsRepo>;
