// Evidence intake routes (M2-01). Every route acts on the session's workspace only: a pack or item of
// another workspace is a 404, indistinguishable from one that does not exist, and nothing is written.
import {
  checkEvidenceText,
  errorEnvelope,
  EVIDENCE_EXCERPT_CHARS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MULTIPART_OVERHEAD_BYTES,
  EVIDENCE_TEXT_BODY_MAX_BYTES,
  EvidenceTextRequestSchema,
  evidenceWireCode,
  SellerEvidenceKindSchema,
  type BlobContent,
  type EvidenceErrorCode,
  type EvidenceItemResponse,
  type SellerEvidenceKind,
  type WorkspaceId,
} from "@cleared/core";
import {
  addEvidence,
  createPostgresBlobStore,
  evidenceSha256,
  prepareEvidenceFile,
  type IntakeFailure,
  type NewEvidence,
} from "@cleared/adapters/files";
import { evidenceRepo, type EvidenceItemRow, type Publisher } from "@cleared/db";
import { checkMutation } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { parseMultipart, readBodyCapped } from "../evidence/body.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, CORRELATION_HEADER, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal, type Session } from "../session.ts";

export type PublisherSource = () => Promise<Pick<Publisher, "emit">>;

/** HTTP status per typed refusal; the envelope code is the snake_case form (`evidence_type`). */
export const EVIDENCE_HTTP_STATUS: Readonly<Record<EvidenceErrorCode, number>> = {
  EVIDENCE_TYPE: 415,
  EVIDENCE_TOO_LARGE: 413,
  EVIDENCE_TOO_MANY_PAGES: 422,
  EVIDENCE_ENCRYPTED: 422,
  EVIDENCE_TOO_MANY_PIXELS: 422,
  EVIDENCE_UNREADABLE: 422,
  EVIDENCE_TEXT_EMPTY: 422,
  EVIDENCE_TEXT_TOO_LONG: 413,
  EVIDENCE_PACK_FULL: 409,
  EVIDENCE_WORKSPACE_FULL: 409,
};

const notFound = (req: Request, what: "pack" | "evidence" | "file"): Response =>
  apiError(
    404,
    "not_found",
    what === "pack"
      ? "Proof pack not found."
      : what === "file"
        ? "This evidence has no file."
        : "Evidence not found.",
    correlationId(req),
  );

function refusal(req: Request, failure: IntakeFailure): Response {
  if (failure.code === "PACK_NOT_FOUND") return notFound(req, "pack");
  const cid = correlationId(req);
  const body = errorEnvelope({
    code: evidenceWireCode(failure.code),
    message: failure.message,
    details: failure.details,
    correlationId: cid,
  });
  return json(body, EVIDENCE_HTTP_STATUS[failure.code], { [CORRELATION_HEADER]: cid });
}

const invalid = (req: Request, message: string): Response =>
  apiError(400, "invalid_request", message, correlationId(req));

export function toEvidenceItem(
  row: EvidenceItemRow,
  file: { readonly mime: string | null; readonly size: number | null },
): EvidenceItemResponse {
  const text = row.text;
  return {
    id: row.id,
    packId: row.packId,
    kind: row.kind,
    sha256: row.sha256,
    mime: row.blobId === null ? null : file.mime,
    size: row.blobId === null ? null : file.size,
    fileUrl: row.blobId === null ? null : `/api/evidence/${row.id}/file`,
    hasText: text !== null,
    textLength: text?.length ?? 0,
    excerpt: text === null ? null : text.slice(0, EVIDENCE_EXCERPT_CHARS),
    createdAt: row.createdAt.toISOString(),
  };
}

async function write(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  session: Session,
  packId: string,
  input: NewEvidence,
): Promise<Response> {
  const ws = session.workspaceId as WorkspaceId;
  const intake = {
    db: deps.db,
    blobs: createPostgresBlobStore(deps.db),
    publisher: await publisher(),
    now: deps.now,
  };
  const added = await addEvidence(intake, ws, packId, input);
  if (!added.ok) return refusal(req, added.error);
  const file =
    input.type === "file" ? { mime: input.file.mime, size: input.file.size } : { mime: null, size: null };
  return withRenewal(json({ item: toEvidenceItem(added.value, file) }, 201), session);
}

/** Session + CSRF + idempotency + pack ownership, shared by both write routes. */
async function guardedWrite(
  req: Request,
  deps: Deps,
  packId: string,
  bodyType: "application/json" | "multipart/form-data",
  route: string,
  run: (session: Session) => Promise<Response>,
): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin, bodyType);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  // The pack id is part of the idempotency scope: the same key on another pack is another request.
  const scope = {
    scopeId: session.sessionId,
    route: route.replace(":packId", packId),
    key: check.idempotencyKey,
  };
  return withIdempotency(req, deps, scope, async () => {
    const owned = await evidenceRepo(deps.db, session.workspaceId as WorkspaceId).packs.getOwned(packId);
    if (owned === null) return notFound(req, "pack");
    return run(session);
  });
}

async function readUpload(
  req: Request,
): Promise<{ ok: true; kind: SellerEvidenceKind; bytes: Uint8Array } | { ok: false; response: Response }> {
  const body = await readBodyCapped(req, EVIDENCE_MAX_BYTES + EVIDENCE_MULTIPART_OVERHEAD_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      response: refusal(req, {
        code: "EVIDENCE_TOO_LARGE",
        message: "Files must be under 10 MB.",
        details: null,
      }),
    };
  }
  const form = await parseMultipart(body.bytes, req.headers.get("content-type") ?? "");
  if (form === null)
    return { ok: false, response: invalid(req, "The upload is not a valid multipart form.") };
  const kind = SellerEvidenceKindSchema.safeParse(form.get("kind"));
  if (!kind.success)
    return {
      ok: false,
      response: invalid(req, "kind must be one of scope, delivery, communication, shipment, invoice."),
    };
  const files = [...form.values()].filter((v): v is File => typeof v !== "string");
  const file = form.get("file");
  if (files.length !== 1 || !(file instanceof File)) {
    return { ok: false, response: invalid(req, "Send exactly one file, in the field named file.") };
  }
  return { ok: true, kind: kind.data, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export const UPLOAD_ROUTE = "POST /api/packs/:packId/evidence/upload";
export const TEXT_ROUTE = "POST /api/packs/:packId/evidence/text";

export function postEvidenceUpload(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  packId: string,
): Promise<Response> {
  return guardedWrite(req, deps, packId, "multipart/form-data", UPLOAD_ROUTE, async (session) => {
    const upload = await readUpload(req);
    if (!upload.ok) return upload.response;
    const prepared = await prepareEvidenceFile(upload.bytes);
    if (!prepared.ok) return refusal(req, prepared.error);
    return write(req, deps, publisher, session, packId, {
      type: "file",
      kind: upload.kind,
      file: prepared.value,
    });
  });
}

export function postEvidenceText(
  req: Request,
  deps: Deps,
  publisher: PublisherSource,
  packId: string,
): Promise<Response> {
  return guardedWrite(req, deps, packId, "application/json", TEXT_ROUTE, async (session) => {
    const body = await readBodyCapped(req, EVIDENCE_TEXT_BODY_MAX_BYTES);
    if (!body.ok) {
      return refusal(req, {
        code: "EVIDENCE_TEXT_TOO_LONG",
        message: "Text must be at most 50,000 characters.",
        details: null,
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return invalid(req, "The body is not valid JSON.");
    }
    const parsed = EvidenceTextRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid(req, "Send { kind, text } with a seller evidence kind.");
    const text = checkEvidenceText(parsed.data.text);
    if (!text.ok) return refusal(req, text.error);
    const sha256 = evidenceSha256({ kind: "text", text: text.value });
    return write(req, deps, publisher, session, packId, {
      type: "text",
      kind: parsed.data.kind,
      text: text.value,
      sha256,
    });
  });
}

/** GET /api/packs/:packId/evidence: newest first. */
export async function getEvidenceList(req: Request, deps: Deps, packId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const repo = evidenceRepo(deps.db, session.workspaceId as WorkspaceId);
  const pack = await repo.packs.getOwned(packId);
  if (pack === null) return notFound(req, "pack");
  const rows = await repo.items.listForPack(pack.id);
  return withRenewal(json({ packId: pack.id, items: rows.map((r) => toEvidenceItem(r, r)) }), session);
}

const EXTENSION: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

/** GET /api/evidence/:id/file: the stored bytes, always as a download, never sniffed or rendered inline. */
export async function getEvidenceFile(req: Request, deps: Deps, id: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const item = await evidenceRepo(deps.db, ws).items.get(id);
  if (item === null) return notFound(req, "evidence");
  if (item.blobId === null) return notFound(req, "file");
  const blob = await createPostgresBlobStore(deps.db).get(ws, item.blobId);
  if (blob === null) return notFound(req, "file");
  const name = `evidence-${item.id.slice(0, 8)}.${EXTENSION[blob.mime] ?? "bin"}`;
  return withRenewal(attachment(blob, name), session);
}

/** Stored bytes as a download: never sniffed, never rendered inline, never cached (M2-01; M3-07 reuses it). */
export function attachment(blob: BlobContent, name: string): Response {
  return new Response(new Uint8Array(blob.bytes), {
    status: 200,
    headers: {
      "content-type": blob.mime,
      "content-length": String(blob.size),
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      etag: `"${blob.sha256}"`,
    },
  });
}
