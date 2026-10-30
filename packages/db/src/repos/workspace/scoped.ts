// The one place a workspace-scoped query is built. Every method adds `workspace_id = <bound id>`; no
// method accepts a raw `where`, so a caller cannot widen the scope (STRIDE: information disclosure).
import { and, desc, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../client.ts";
import type { Executor } from "../../tx.ts";

export type ScopedTable = PgTable & { id: PgColumn; workspaceId: PgColumn; createdAt: PgColumn };

/** Columns the repo owns: the caller never sets them. */
type Owned = "id" | "workspaceId" | "createdAt";
const OWNED: ReadonlySet<string> = new Set<Owned>(["id", "workspaceId", "createdAt"]);

export type Row<T extends ScopedTable> = InferSelectModel<T>;
export type NewRow<T extends ScopedTable> = Omit<InferInsertModel<T>, Owned>;
export type RowPatch<T extends ScopedTable> = Partial<NewRow<T>>;

export interface ListOptions {
  readonly limit?: number;
  readonly tx?: Executor;
}

export interface ScopedRepo<T extends ScopedTable> {
  /** Newest first (`created_at desc`), at most `limit` rows (default 100, max 500). */
  list(opts?: ListOptions): Promise<Row<T>[]>;
  /** `null` when the row does not exist **or belongs to another workspace**. */
  get(id: string, tx?: Executor): Promise<Row<T> | null>;
  insert(values: NewRow<T>, tx?: Executor): Promise<Row<T>>;
}

export interface MutableScopedRepo<T extends ScopedTable> extends ScopedRepo<T> {
  /** `null` when no row with this id exists in this workspace. */
  update(id: string, patch: RowPatch<T>, tx?: Executor): Promise<Row<T> | null>;
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-uuid id can never match; answering `null` avoids a Postgres cast error. */
export const isUuid = (id: string): boolean => UUID.test(id);

/** Widens a generic table for `.from()`, whose conditional parameter type a generic `T` cannot satisfy. */
function source(table: ScopedTable): PgTable {
  return table;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)));
}

export function scopedRepo<T extends ScopedTable>(db: Db, table: T, workspaceId: string): ScopedRepo<T> {
  const inScope = eq(table.workspaceId, workspaceId);
  return {
    async list(opts = {}) {
      const ex = opts.tx ?? db;
      const rows = await ex
        .select()
        .from(source(table))
        .where(inScope)
        .orderBy(desc(table.createdAt))
        .limit(clampLimit(opts.limit));
      return rows as Row<T>[];
    },
    async get(id, tx) {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(source(table))
        .where(and(inScope, eq(table.id, id)))
        .limit(1);
      return (rows[0] as Row<T> | undefined) ?? null;
    },
    async insert(values, tx) {
      const rows = await (tx ?? db)
        .insert(table)
        .values({ ...values, workspaceId } as InferInsertModel<T>)
        .returning();
      const row = (rows as Row<T>[])[0];
      if (!row) throw new Error("insert returned no row");
      return row;
    },
  };
}

export function mutableScopedRepo<T extends ScopedTable>(
  db: Db,
  table: T,
  workspaceId: string,
): MutableScopedRepo<T> {
  return {
    ...scopedRepo(db, table, workspaceId),
    async update(id, patch, tx) {
      if (!isUuid(id)) return null;
      // Owned columns are dropped at runtime too, so a cast at a call site cannot move a row.
      const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !OWNED.has(k)));
      const rows = await (tx ?? db)
        .update(table)
        // `never`: drizzle's set-source type cannot be resolved for a generic table; the keys are checked
        // by `RowPatch<T>` at the call site.
        .set(rest as never)
        .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
        .returning();
      return (rows as Row<T>[])[0] ?? null;
    },
  };
}

/** One row by a unique business key (e.g. `capture_id`), still inside the workspace. */
export async function findOneInScope<T extends ScopedTable>(
  ex: Executor,
  table: T,
  workspaceId: string,
  column: PgColumn,
  value: string,
): Promise<Row<T> | null> {
  const rows = await ex
    .select()
    .from(source(table))
    .where(and(eq(table.workspaceId, workspaceId), eq(column, value)))
    .limit(1);
  return (rows[0] as Row<T> | undefined) ?? null;
}
