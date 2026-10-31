// GET /api/audit (M2-09, audit-log.md): the session's workspace's audit log, newest first, 50 per page
// with an opaque cursor, filtered by actor, kind and an ID fragment. Read only: there is no write route.
import {
  AUDIT_ACTOR_FILTERS,
  AUDIT_KIND_FILTERS,
  AUDIT_PAGE_SIZE,
  auditPage,
  platform,
  type AuditCursor,
} from "@cleared/db";
import { z } from "zod";
import type { AuditPageData } from "../../lib/dispute-view.ts";
import { auditEntry } from "../audit-entry.ts";
import type { Deps } from "../deps.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";

const CursorSchema = z.object({ at: z.string().min(10).max(40), id: z.uuid() });

const QuerySchema = z.object({
  cursor: z.string().max(200).nullable(),
  actor: z.enum(AUDIT_ACTOR_FILTERS).nullable(),
  kind: z.enum(AUDIT_KIND_FILTERS).nullable(),
  /** IDs only: PayPal ids, debug_ids, hex fingerprints, uuids */
  q: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,64}$/)
    .nullable(),
});

export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): AuditCursor | null {
  try {
    const r = CursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function getAudit(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const p = new URL(req.url).searchParams;
  const empty = (k: string): string | null => (p.get(k) === "" ? null : p.get(k));
  const q = QuerySchema.safeParse({
    cursor: empty("cursor"),
    actor: empty("actor"),
    kind: empty("kind"),
    q: empty("q"),
  });
  const cursor = q.success && q.data.cursor !== null ? decodeCursor(q.data.cursor) : null;
  if (!q.success || (q.data.cursor !== null && cursor === null)) {
    return apiError(400, "invalid_request", "Unknown filter or cursor.", correlationId(req));
  }
  const ws = await platform(deps.db).workspaces.get(session.workspaceId);
  const page = await auditPage(deps.db, session.workspaceId, {
    cursor,
    actor: q.data.actor,
    kind: q.data.kind,
    q: q.data.q,
    limit: AUDIT_PAGE_SIZE,
  });
  const body: AuditPageData = {
    items: page.rows.map(auditEntry),
    next: page.next === null ? null : encodeCursor(page.next),
    workspace: { timezone: ws?.timezone ?? "UTC" },
  };
  return withRenewal(json(body), session);
}
