---
title: "M3-06 · Client acknowledgement link"
milestone: "M3 · Holds & Cash"
labels: [backend, frontend, security]
blocked_by: [M2-GATE]
estimate: "4h"
resources: []
needs: []
---

## Context
PayPal asks service sellers for "an invoice or a contract signed by both parties", and the seller's own scope text is one-sided (B6 #9). A **client acknowledgement link** lets the buyer confirm "I agree to this scope". This records **buyer-side evidence** (timestamp, IP, user agent) in the proof pack. It strengthens the pack for holds, disputes and document requests (pillar P1 → **Innovation**, **Impact**).

## Scope
- Seller action on a proof pack: "Create acknowledgement link" for the pack's current `scope` evidence item.
  - Token: 32 random bytes, base64url. Only the sha256 is stored in `client_acks.token_hash`.
  - The link is bound to the scope item's sha256.
  - Expiry: 30 days or the workspace expiry, whichever is first.
  - One active link per scope item; the seller can revoke it.
  - Creation and revocation go to the audit log.
- Public page `/ack/[token]` (no session):
  - shows the seller display name, the payment amount/currency and the scope text as **plain text**
  - the client types their name, ticks "I agree to this scope" and submits
  - EN/HI; `noindex`; no third-party scripts; strict CSP
  - Invalid, expired, revoked or already-accepted tokens show a neutral page that reveals nothing.
- `POST /api/ack/[token]`. It validates with zod and checks the Origin header; it is rate-limited per IP and per token. If the scope item hash changed since creation, it refuses ("The scope changed; ask the seller for a new link"). In **one transaction** it:
  - sets `accepted_at`, `ip` (from Render's `x-forwarded-for`, first hop) and `user_agent`
  - appends an immutable `evidence_items` row, kind `client_ack`. Its text is a canonical JSON of {scope_sha256, typed name, accepted_at, ip, user_agent}, with its sha256.
  - marks the pack `stale`
  - writes an `evidence.added` outbox row
  - The write is idempotent on token_hash.
- Seller view: link status (pending / accepted with time / expired / revoked) and a copy-link button.

## Out of scope
- Scope snapshot PDF that embeds the ack: M3-07
- Emailing the link to the client: not in scope (the seller shares it); alert emails are M3-08
- Security review and STRIDE doc: M4-05 (this ticket adds its own tests)

## Acceptance Criteria
- [ ] Integration: create → accept writes exactly one `client_acks` acceptance and one `client_ack` evidence item with a sha256 that matches its text; a second submit is a no-op (idempotent)
- [ ] The raw token is never stored (a test greps the row: only the hash is present)
- [ ] Expired, revoked, unknown and scope-changed tokens all return the same neutral response and status (test table)
- [ ] The rate limit returns 429 after N attempts per IP (test)
- [ ] Scope text with `<script>` renders escaped on the public page (Playwright)
- [ ] The pack becomes `stale` and an `evidence.added` outbox row is written in the same transaction (test rolls back on a forced failure and finds neither)
- [ ] axe clean (WCAG 2.2 AA) on the public page and the seller view; 360 px; `ui-reviewer` passes

## Deliverables
- `packages/core/src/proof/client-ack.ts` (+ tests)
- `apps/web/app/[locale]/ack/[token]/page.tsx`, `apps/web/app/api/ack/[token]/route.ts`, `apps/web/app/api/packs/[id]/ack-links/route.ts`
- `apps/web/components/proof/ack-link.tsx`, `apps/web/e2e/client-ack.spec.ts`, message keys

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- client-ack
pnpm --filter ./apps/web test -- ack
pnpm --filter ./apps/web exec playwright test e2e/client-ack.spec.ts --reporter=line > "$TMPDIR/m3-06-e2e.txt"; tail -5 "$TMPDIR/m3-06-e2e.txt"
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-07 embeds the acceptance record in the scope snapshot
- M2-07's dispute draft can select the `client_ack` evidence item
- M4-05 includes the public route in the STRIDE review
- M3-11 shows the link in the storyboard (0:20–0:45)
