---
title: "M2-01 · Evidence intake (upload sniff/caps/re-encode, paste chat, BlobStore, sha256, immutable)"
milestone: "M2 · Dispute Loop"
labels: [backend, security, critical]
blocked_by: [M1-GATE]
estimate: "5h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14]
---

## Context
Every later step (extraction, scope check, dispute draft, compiled PDF) reads evidence, so evidence must be safe to ingest, immutable and content-addressed. Buyer-written chats and uploaded files are the main injection and file-bomb surface (architecture §8, B6 #14). Rubric: Technological Implementation (a trustworthy system of record), Potential Impact (sellers capture proof at payment time, not after PayPal asks).

## Scope
- REST routes in `apps/web` (zod-validated, workspace-scoped, Idempotency-Key, one error envelope):
  - `POST /api/packs/:packId/evidence/upload` (multipart, one file per call, `kind` from the `evidence_items.kind` enum)
  - `POST /api/packs/:packId/evidence/text` (pasted chat or scope text, ≤ 50,000 chars)
  - `GET /api/packs/:packId/evidence` (list, newest first) and `GET /api/evidence/:id/file` (streams the blob with its stored mime, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`)
- File guards (pure checks in `packages/core`, byte handling in `packages/adapters`):
  - type by **magic bytes**, never the filename or client mime; allow only jpg, png, gif, pdf (PayPal's evidence types)
  - size ≤ 10 MB; PDF ≤ 30 pages and not encrypted; image ≤ 25 megapixels (checked from the header before decode)
  - images re-encoded (strips metadata and polyglot payloads); PDFs parsed and re-saved; the stored bytes are the re-encoded ones
  - PDF text layer extracted deterministically into `evidence_items.text` (no model); images keep `text = null`
- `BlobStore` interface in `packages/core` with a Postgres `bytea` implementation in `packages/adapters`; content-addressed: identical bytes reuse one `blobs` row
- Each `evidence_items` row stores `sha256` of the stored bytes (or of the normalised text: NFC, `\r\n` → `\n`). Rows are append-only: no update/delete routes; repository exposes insert + read only
- Ownership: the pack's payment must belong to the session's workspace; otherwise 404
- One transaction: blob + evidence row + pack state (`collecting`, or `stale` if it was `checked`/`ready`) + outbox `evidence.added` (version 1)
- Rate limit per workspace: 50 evidence items per pack, 200 MB per workspace

## Out of scope
- Model extraction of facts (M2-03); the upload/paste UI (M2-05)
- Scope snapshot and client acknowledgement evidence kinds' producers (M3-06, M3-07)
- Retention purge (M4-07); STRIDE write-up (M4-05)

## Acceptance Criteria
- [ ] A jpg/png/gif/pdf under the caps is stored once; uploading the same bytes twice yields two evidence rows sharing one blob, both with the same sha256
- [ ] A `.png`-named HTML file, a 10 MB + 1 byte file, a 31-page PDF, an encrypted PDF and a 26 MP image are each rejected with a typed error code (`EVIDENCE_TYPE`, `EVIDENCE_TOO_LARGE`, `EVIDENCE_TOO_MANY_PAGES`, `EVIDENCE_ENCRYPTED`, `EVIDENCE_TOO_MANY_PIXELS`)
- [ ] Re-encoded images carry no EXIF (test asserts on the stored bytes)
- [ ] A text-layer PDF's text lands in `evidence_items.text`; the sha256 of pasted text is stable across `\r\n`/`\n` variants
- [ ] There is no code path that updates or deletes `evidence_items` (repository test + `grep` in the gate)
- [ ] A cross-workspace upload or read returns 404 and writes nothing
- [ ] Adding evidence to a `checked` pack sets it `stale` and enqueues `evidence.added` in the same transaction (test kills the transaction midway: neither row exists)
- [ ] Served files carry `nosniff` and `attachment`

## Deliverables
- `packages/core/src/proof/evidence.ts` (caps, kinds, normalisation, sha256 rules) + `evidence.test.ts`
- `packages/core/src/ports/blob-store.ts`
- `packages/adapters/src/files/sniff.ts`, `reencode.ts`, `pdf-text.ts` + tests with synthetic sample files under `fixtures/files/`
- `packages/adapters/src/blob/postgres-blob-store.ts`
- `packages/db/src/repositories/evidence.ts` (insert/read only)
- `apps/web/app/api/packs/[packId]/evidence/**`, `apps/web/app/api/evidence/[id]/file/route.ts`
- Integration test `apps/web/test/evidence.int.test.ts`

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/proof
pnpm --filter ./packages/adapters exec vitest run src/files src/blob
pnpm --filter ./apps/web exec vitest run test/evidence.int.test.ts
! grep -rnE "(update|delete)\(.*evidence_?[iI]tems" packages/db/src apps/web/app
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-03 consumes `evidence.added` and reads `evidence_items.text` + blob bytes
- M2-04 verifies quotes against `evidence_items.text` only (image evidence has no text, so it cannot be cited verbatim)
- M2-05 calls the three routes; M2-07 embeds blobs into the compiled PDF; M2-10 seeds synthetic evidence through the same routes
