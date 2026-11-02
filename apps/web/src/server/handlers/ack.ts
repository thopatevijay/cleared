// Public side of the client acknowledgement link (M3-06): the page `/[locale]/ack/[token]` and
// `POST /api/ack/:token`. No session. Unknown, expired, revoked, scope-changed and (on the page)
// already-accepted tokens all get one neutral answer that reveals nothing about which case it is.
// The accept writes, in one transaction: the `client_ack` evidence item (canonical JSON + sha256), the
// pack's new state, the `evidence.added` outbox row (both through the shared evidence write), the
// acceptance on the link and an audit row. It is idempotent on the token hash: the link row is locked,
// and a second submit of an accepted token returns the first acceptance and writes nothing.
import {
  ACK_RATE_PER_IP,
  ACK_RATE_PER_TOKEN,
  ACK_RATE_WINDOW_MS,
  ackLinkStatus,
  ackTokenHash,
  AckSubmitSchema,
  AckTokenSchema,
  clientAckEvidence,
  WorkspaceIdSchema,
} from "@cleared/core";
import { createPostgresBlobStore, EvidenceRefusedError, writeEvidence } from "@cleared/adapters/files";
import {
  clientAckByToken,
  clientAcksRepo,
  evidenceRepo,
  forWorkspace,
  markClientAckAccepted,
  rateLimitHit,
  withTransaction,
} from "@cleared/db";
import { clientIp, ipHash } from "../client-ip.ts";
import type { Deps } from "../deps.ts";
import { readBodyCapped } from "../evidence/body.ts";
import { apiError, correlationId, json } from "../respond.ts";
import type { PublisherSource } from "./evidence.ts";

const BODY_MAX_BYTES = 4096;

/** The one answer for every unusable token: same status, same body. */
export const ACK_NEUTRAL_STATUS = 404;
export const ACK_NEUTRAL_BODY = {
  error: {
    code: "ack_unavailable",
    message: "This link can't be used. Ask the person who sent it for a new one.",
  },
} as const;
const neutral = (): Response => json(ACK_NEUTRAL_BODY, ACK_NEUTRAL_STATUS);

export interface PublicAck {
  readonly sellerName: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly scopeText: string;
}

/** The public page's data, or null for the neutral page (any unusable token, accepted ones included). */
export async function loadPublicAck(deps: Deps, token: string): Promise<PublicAck | null> {
  if (!AckTokenSchema.safeParse(token).success) return null;
  const found = await clientAckByToken(deps.db, ackTokenHash(token));
  if (found === null || found.scopeText === null) return null;
  if (ackLinkStatus(found.ack, found.currentScopeSha256, deps.now()) !== "pending") return null;
  return {
    sellerName: found.sellerName,
    amount: found.amount,
    currency: found.currency,
    scopeText: found.scopeText,
  };
}

async function rateLimited(req: Request, deps: Deps, token: string): Promise<Response | null> {
  const now = deps.now();
  const ip = ipHash(clientIp(req.headers), deps.config.sessionSecret);
  const tooMany = (): Response =>
    apiError(429, "rate_limited", "Too many attempts. Try again in a few minutes.", correlationId(req), {
      "retry-after": String(ACK_RATE_WINDOW_MS / 1000),
    });
  if ((await rateLimitHit(deps.db, `ack:ip:${ip}`, now, ACK_RATE_WINDOW_MS)) > ACK_RATE_PER_IP)
    return tooMany();
  // Hashing an arbitrary path segment is safe: the bucket never holds the raw value.
  const bucket = `ack:token:${ackTokenHash(token.slice(0, 64))}`;
  if ((await rateLimitHit(deps.db, bucket, now, ACK_RATE_WINDOW_MS)) > ACK_RATE_PER_TOKEN) return tooMany();
  return null;
}

/** JSON only, from Cleared's own origin (the public page posts it with fetch). */
function checkRequest(req: Request, appOrigin: string): Response | null {
  const cid = correlationId(req);
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return apiError(415, "unsupported_media_type", "Send the request as application/json.", cid);
  }
  if (req.headers.get("origin") !== appOrigin) {
    return apiError(403, "forbidden_origin", "This request did not come from Cleared.", cid);
  }
  return null;
}

async function readSubmit(req: Request) {
  const body = await readBodyCapped(req, BODY_MAX_BYTES);
  if (!body.ok) return null;
  try {
    const parsed = AckSubmitSchema.safeParse(JSON.parse(new TextDecoder().decode(body.bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type AcceptOutcome = { readonly acceptedAt: Date } | "neutral";

async function accept(
  deps: Deps,
  publisher: PublisherSource,
  tokenHash: string,
  record: { readonly name: string; readonly ip: string; readonly userAgent: string },
): Promise<AcceptOutcome> {
  const pub = await publisher();
  return withTransaction(deps.db, async (tx) => {
    // Locks the link row: concurrent submits of one token run one after the other.
    const found = await clientAckByToken(deps.db, tokenHash, tx);
    if (found === null) return "neutral";
    if (found.ack.acceptedAt !== null) return { acceptedAt: found.ack.acceptedAt };
    const ws = WorkspaceIdSchema.parse(found.ack.workspaceId);
    // Evidence writes in this workspace wait here, so the scope cannot change between this read and the write.
    await evidenceRepo(deps.db, ws).lockWorkspace(tx);
    const scope = await clientAcksRepo(deps.db, ws).currentScopeItem(found.ack.packId, tx);
    const now = deps.now();
    if (ackLinkStatus(found.ack, scope?.sha256 ?? null, now) !== "pending") return "neutral";
    const evidence = clientAckEvidence({
      scopeSha256: found.ack.scopeSha256,
      typedName: record.name,
      acceptedAt: now,
      ip: record.ip,
      userAgent: record.userAgent,
    });
    const intake = { db: deps.db, blobs: createPostgresBlobStore(deps.db), publisher: pub, now: deps.now };
    const item = await writeEvidence(intake, tx, ws, found.ack.packId, {
      type: "text",
      kind: "client_ack",
      text: evidence.text,
      sha256: evidence.sha256,
    });
    const marked = await markClientAckAccepted(tx, found.ack.id, {
      acceptedAt: now,
      ip: record.ip,
      userAgent: record.userAgent,
      evidenceItemId: item.id,
    });
    if (!marked) throw new Error("client ack changed under its row lock");
    await forWorkspace(deps.db, ws).auditLog.insert(
      {
        actor: "system",
        action: "ack.accepted",
        detail: { ackId: found.ack.id, packId: found.ack.packId, evidenceItemId: item.id },
      },
      tx,
    );
    return { acceptedAt: now };
  });
}

/** POST /api/ack/:token `{ name, agree: true }` → 200 `{ status: "accepted", acceptedAt }`. */
export async function postAck(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  token: string,
): Promise<Response> {
  const bad = checkRequest(req, deps.config.appOrigin);
  if (bad !== null) return bad;
  const limited = await rateLimited(req, deps, token);
  if (limited !== null) return limited;
  if (!AckTokenSchema.safeParse(token).success) return neutral();
  const submit = await readSubmit(req);
  if (submit === null) {
    return apiError(
      400,
      "invalid_request",
      "Send { name, agree: true }; name is 1 to 120 characters.",
      correlationId(req),
    );
  }
  const record = {
    name: submit.name,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent") ?? "",
  };
  let out: AcceptOutcome;
  try {
    out = await accept(deps, publisher, ackTokenHash(token), record);
  } catch (error) {
    if (!(error instanceof EvidenceRefusedError)) throw error;
    return apiError(
      409,
      "ack_not_recorded",
      "The confirmation couldn't be added to this pack.",
      correlationId(req),
    );
  }
  if (out === "neutral") return neutral();
  return json({ status: "accepted", acceptedAt: out.acceptedAt.toISOString() });
}
