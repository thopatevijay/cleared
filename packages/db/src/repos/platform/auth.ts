// M1-05 auth: magic links, sessions, demo caps and system audit rows. These run before a workspace is
// known (a new email, an anonymous demo request) or across workspaces (the global demo cap), so they
// live on `platform(db)`. Each method that changes a row also matches its `workspace_id` when it has one.
import { and, count, eq, gt, gte, isNull, sql, type InferInsertModel } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { auditLog, magicLinks, sessions, workspaces } from "../../../schema/index.ts";
import type { Executor, Tx } from "../../tx.ts";
import type { MagicLinkRow, SessionRow } from "./accounts.ts";

export type NewMagicLinkRow = Omit<InferInsertModel<typeof magicLinks>, "id" | "createdAt" | "usedAt">;
export type NewSessionRow = Omit<InferInsertModel<typeof sessions>, "id" | "createdAt">;

/** One lock id for every demo-cap check (pg advisory lock, held to the end of the transaction). */
export const DEMO_CAPS_LOCK_ID = 0x0c1ea4ed;

export function authRepo(db: Db) {
  return {
    /** Magic links requested since `since` for one email (lower-cased) or one IP hash. */
    async countMagicLinksSince(
      by: { readonly email: string } | { readonly ipHash: string },
      since: Date,
      tx?: Executor,
    ): Promise<number> {
      const who =
        "email" in by
          ? eq(magicLinks.email, by.email.toLowerCase())
          : eq(magicLinks.requestedIpHash, by.ipHash);
      const rows = await (tx ?? db)
        .select({ n: count() })
        .from(magicLinks)
        .where(and(who, gte(magicLinks.createdAt, since)));
      return rows[0]?.n ?? 0;
    },

    async createMagicLink(values: NewMagicLinkRow, tx?: Executor): Promise<MagicLinkRow> {
      const rows = await (tx ?? db)
        .insert(magicLinks)
        .values({ ...values, email: values.email.toLowerCase() })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("magic link insert returned no row");
      return row;
    },

    /**
     * Marks the link used if it exists, is unused and has not expired at `now`, in one statement, so
     * two concurrent verifies cannot both succeed. Returns the consumed row, or null.
     */
    async consumeMagicLink(tokenHash: string, now: Date, tx?: Executor): Promise<MagicLinkRow | null> {
      const rows = await (tx ?? db)
        .update(magicLinks)
        .set({ usedAt: now })
        .where(
          and(eq(magicLinks.tokenHash, tokenHash), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, now)),
        )
        .returning();
      return rows[0] ?? null;
    },

    async createSession(values: NewSessionRow, tx?: Executor): Promise<SessionRow> {
      const rows = await (tx ?? db).insert(sessions).values(values).returning();
      const row = rows[0];
      if (!row) throw new Error("session insert returned no row");
      return row;
    },

    /** Sliding renewal: records use and moves the expiry. */
    async touchSession(
      id: string,
      workspaceId: string,
      at: Date,
      expiresAt: Date,
      tx?: Executor,
    ): Promise<void> {
      await (tx ?? db)
        .update(sessions)
        .set({ lastSeenAt: at, expiresAt })
        .where(and(eq(sessions.id, id), eq(sessions.workspaceId, workspaceId)));
    },

    /** Deletes one session of one workspace; `true` when a row went. */
    async deleteSession(id: string, workspaceId: string, tx?: Executor): Promise<boolean> {
      const rows = await (tx ?? db)
        .delete(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.workspaceId, workspaceId)))
        .returning({ id: sessions.id });
      return rows.length === 1;
    },

    /** Serialises demo-cap checks: call first inside the creating transaction. */
    async lockDemoCaps(tx: Tx): Promise<void> {
      await tx.execute(sql`select pg_advisory_xact_lock(${DEMO_CAPS_LOCK_ID})`);
    },

    /** Demo workspaces created since `since`, optionally from one IP hash. */
    async countDemoWorkspacesSince(since: Date, ipHash?: string, tx?: Executor): Promise<number> {
      const base = and(
        eq(workspaces.kind, "demo"),
        eq(workspaces.synthetic, false),
        gte(workspaces.createdAt, since),
      );
      const where = ipHash === undefined ? base : and(base, eq(workspaces.createdIpHash, ipHash));
      const rows = await (tx ?? db).select({ n: count() }).from(workspaces).where(where);
      return rows[0]?.n ?? 0;
    },

    /** Creation times (oldest first) of one IP hash's demo workspaces since `since` (the per-IP cap). */
    async demoWorkspaceTimesSince(since: Date, ipHash: string, tx?: Executor): Promise<Date[]> {
      const rows = await (tx ?? db)
        .select({ at: workspaces.createdAt })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.kind, "demo"),
            eq(workspaces.synthetic, false),
            gte(workspaces.createdAt, since),
            eq(workspaces.createdIpHash, ipHash),
          ),
        )
        .orderBy(workspaces.createdAt);
      return rows.map((r) => r.at);
    },

    /** Demo workspaces not yet expired at `now` (the global cap counts these). */
    async countLiveDemoWorkspaces(now: Date, tx?: Executor): Promise<number> {
      const rows = await (tx ?? db)
        .select({ n: count() })
        .from(workspaces)
        .where(
          and(eq(workspaces.kind, "demo"), eq(workspaces.synthetic, false), gt(workspaces.expiresAt, now)),
        );
      return rows[0]?.n ?? 0;
    },

    /** An `audit_log` row with actor `system`; `workspaceId` null for platform events (cap refusals). */
    async auditSystem(
      entry: {
        readonly workspaceId: string | null;
        readonly action: string;
        readonly detail: Record<string, unknown>;
      },
      tx?: Executor,
    ): Promise<void> {
      await (tx ?? db).insert(auditLog).values({
        workspaceId: entry.workspaceId,
        actor: "system",
        action: entry.action,
        detail: entry.detail,
      });
    },
  };
}
