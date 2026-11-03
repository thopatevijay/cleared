// Lookups that happen before a workspace is known: creating a workspace, resolving a session or magic
// link from its token hash, finding a seller by email, and per-session idempotency keys. Each returns
// the row's `workspace_id`; the caller then switches to `forWorkspace` for everything else.
import { and, count, eq, gte, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { idempotencyKeys, magicLinks, sessions, users, workspaces } from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { isUuid } from "../workspace/scoped.ts";

export type WorkspaceRow = InferSelectModel<typeof workspaces>;
export type NewWorkspaceRow = Omit<InferInsertModel<typeof workspaces>, "createdAt">;
export type SessionRow = InferSelectModel<typeof sessions>;
export type MagicLinkRow = InferSelectModel<typeof magicLinks>;
export type UserRow = InferSelectModel<typeof users>;
export type IdempotencyKeyRow = InferSelectModel<typeof idempotencyKeys>;

export function workspacesRepo(db: Db) {
  return {
    async create(values: NewWorkspaceRow, tx?: Executor): Promise<WorkspaceRow> {
      const rows = await (tx ?? db).insert(workspaces).values(values).returning();
      const row = rows[0];
      if (!row) throw new Error("workspace insert returned no row");
      return row;
    },
    async get(id: string, tx?: Executor): Promise<WorkspaceRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db).select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
      return rows[0] ?? null;
    },
    /** M4-03: the seller's own settings (language switch, time-zone control); the updated row, or null. */
    async updateSettings(
      id: string,
      values: Partial<Pick<WorkspaceRow, "locale" | "timezone">>,
      tx?: Executor,
    ): Promise<WorkspaceRow | null> {
      if (!isUuid(id)) return null;
      if (values.locale === undefined && values.timezone === undefined) return this.get(id, tx);
      const rows = await (tx ?? db).update(workspaces).set(values).where(eq(workspaces.id, id)).returning();
      return rows[0] ?? null;
    },
    /**
     * Whether a PayPal mirror (capture or dispute sync) may still write into the workspace, with its row
     * locked `for share` until `tx` ends. A synthetic workspace past `expires_at` takes no more rows: its
     * purge sets `expires_at` and holds the row `for update`, so a sync that read the owner row before the
     * purge committed waits here and then sees the purge (BL-01 6594517545). A demo workspace the retention
     * purge emptied (`purged_at`, M4-07) takes none either: `purge_workspace` locks the row the same way.
     */
    async acceptsMirror(id: string, now: Date, tx: Executor): Promise<boolean> {
      const rows = await tx
        .select({
          synthetic: workspaces.synthetic,
          expiresAt: workspaces.expiresAt,
          purgedAt: workspaces.purgedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for("share");
      const ws = rows[0];
      if (ws === undefined || ws.purgedAt !== null) return false;
      return !(ws.synthetic && ws.expiresAt !== null && ws.expiresAt.getTime() <= now.getTime());
    },
    /** Demo caps (ADR 0007): workspaces created since `since`, optionally from one IP hash. */
    async countCreatedSince(since: Date, ipHash?: string, tx?: Executor): Promise<number> {
      const recent = gte(workspaces.createdAt, since);
      const where = ipHash === undefined ? recent : and(recent, eq(workspaces.createdIpHash, ipHash));
      const rows = await (tx ?? db).select({ n: count() }).from(workspaces).where(where);
      return rows[0]?.n ?? 0;
    },
  };
}

export function identityRepo(db: Db) {
  return {
    async sessionByTokenHash(tokenHash: string, tx?: Executor): Promise<SessionRow | null> {
      const rows = await (tx ?? db).select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
      return rows[0] ?? null;
    },
    async magicLinkByTokenHash(tokenHash: string, tx?: Executor): Promise<MagicLinkRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(magicLinks)
        .where(eq(magicLinks.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },
    /** `email` is compared lower-cased (stored lower-cased). */
    async userByEmail(email: string, tx?: Executor): Promise<UserRow | null> {
      const rows = await (tx ?? db).select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
      return rows[0] ?? null;
    },
  };
}

export function idempotencyKeysRepo(db: Db) {
  return {
    async get(
      sessionId: string,
      route: string,
      key: string,
      tx?: Executor,
    ): Promise<IdempotencyKeyRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.sessionId, sessionId),
            eq(idempotencyKeys.route, route),
            eq(idempotencyKeys.key, key),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    /** `true` when stored; `false` when (session, route, key) already exists. */
    async put(
      row: { sessionId: string; route: string; key: string; responseHash: string | null },
      tx?: Executor,
    ): Promise<boolean> {
      const rows = await (tx ?? db)
        .insert(idempotencyKeys)
        .values(row)
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      return rows.length === 1;
    },
    /** M1-05: stores the response a replay returns. */
    async complete(
      row: {
        sessionId: string;
        route: string;
        key: string;
        responseHash: string;
        responseStatus: number;
        responseBody: unknown;
      },
      tx?: Executor,
    ): Promise<void> {
      await (tx ?? db)
        .update(idempotencyKeys)
        .set({
          responseHash: row.responseHash,
          responseStatus: row.responseStatus,
          responseBody: row.responseBody,
        })
        .where(keyIs(row.sessionId, row.route, row.key));
    },
    /** M1-05: frees a claimed key whose request failed before it produced a response. */
    async release(sessionId: string, route: string, key: string, tx?: Executor): Promise<void> {
      await (tx ?? db).delete(idempotencyKeys).where(keyIs(sessionId, route, key));
    },
  };
}

function keyIs(sessionId: string, route: string, key: string) {
  return and(
    eq(idempotencyKeys.sessionId, sessionId),
    eq(idempotencyKeys.route, route),
    eq(idempotencyKeys.key, key),
  );
}
