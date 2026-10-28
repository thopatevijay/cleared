---
title: "M1-05 · Auth: magic link (Resend) + anonymous demo workspaces + caps"
milestone: "M1 · Walking Skeleton"
labels: [backend, security]
blocked_by: [M1-02]
estimate: "5h"
resources: []
needs: []
---

## Context
Judges must test with no keys and no accounts (a disqualifying rule if missed). Sellers need sign-in without stored passwords. One visitor must not exhaust shared limits for everyone (B6 #3, #8; ADR 0007). This serves **Presentation** (instant "Try as demo seller"), **Design** (honest, simple access) and the security story (cross-workspace isolation, DoS caps).

## Scope
- **Session model:**
  - an opaque 32-byte random token in the cookie `__Host-cleared_session` (httpOnly, Secure outside development, SameSite=Lax, Path=/); only `sha256(token)` is stored in `sessions`
  - seller sessions last 30 days with sliding renewal on use (`last_seen_at`); demo sessions last until the workspace's `expires_at`
- **`getSession(req)`** returns `{ sessionId, workspaceId, kind, userId? }` or null. **`requireSession`** is used by every non-public route and returns the ADR 0003 envelope with 401. The workspace ID comes **only** from the session, never from the client
- **CSRF:** mutating routes require `Content-Type: application/json`, an `Origin` equal to `APP_BASE_URL` and an `Idempotency-Key` header (stored in `idempotency_keys` with the response hash; a replay returns the stored response)
- **Magic link** (`POST /api/auth/magic-link`, `GET /api/auth/verify?token=…`):
  - zod-validated email
  - 32-byte token, hash stored, 15-minute expiry, single use (consumed in the same transaction that creates the session)
  - the first verify of a new email creates the user and a seller workspace (locale and tz from `Accept-Language` and a client-supplied IANA tz validated against `Intl.supportedValuesOf('timeZone')`)
  - the response is the same whether or not the email exists (no account enumeration)
  - rate limits: 5 requests per email per hour and 20 per IP per hour, counted from `magic_links`
- **Email:**
  - adapter `packages/adapters/src/email/resend.ts`: the Resend SDK behind an `EmailSender` interface, sending through the shared HTTP client's timeout (10 s), with EN and HI plain-text plus HTML templates
  - **Recipient guard:** whenever `EMAIL_RECIPIENT_ALLOWLIST` is set (it is set in every environment through the hackathon, per CLAUDE.md "never email anyone except verified test recipients"), mail goes only to the listed addresses. Any other address is refused with a logged reason. The response to the client stays identical
- **Demo workspace** (`POST /api/demo`):
  - creates a `demo` workspace (expires 2026-12-16T00:00Z), a demo session with no email, and `llm_budget_usd = LLM_WORKSPACE_CAP_USD`
  - caps: `DEMO_WORKSPACES_PER_IP_PER_DAY` (3) by `created_ip_hash` (HMAC-SHA256 of the IP with `SESSION_SECRET`; the raw IP is never stored) and `DEMO_WORKSPACES_GLOBAL_MAX` (200) on live demo workspaces, both checked inside the creating transaction (serialisable, or an advisory lock)
  - a capped request gets 429 with a plain message and `Retry-After`
- **Client IP helper:** uses the header Render's proxy sets (`True-Client-IP` if present, else the last `X-Forwarded-For` hop), never a client-supplied first hop. The behaviour is unit-tested; the real header is confirmed in M1-07
- `POST /api/auth/sign-out` deletes the session row and clears the cookie
- Every sign-in, demo creation and cap refusal writes `audit_log` (actor `system`)

## Out of scope
- Sign-in, check-email and landing pages, and the "Try as demo seller" button → M1-07 (built to `docs/design/`)
- LLM budget enforcement → M2-02
- Email alerts → M3-08
- Demo purge → M4-07
- A full authZ test sweep → M4-05

## Acceptance Criteria
- [ ] **Magic-link flow (integration, msw replaying the recorded Resend response):** request → token captured from the intercepted request body → verify sets the cookie → `requireSession` passes. A second verify of the same token → 400; a token after 15 min (injected clock) → 400
- [ ] **No enumeration:** known and unknown emails get byte-identical responses (test)
- [ ] **Allowlist:** a non-allowlisted address results in no Resend request (msw asserts) and a 200 response (test)
- [ ] **Demo caps:** the 4th demo request from one IP in a day → 429; with the global max set to 2, the 3rd → 429; 10 concurrent requests from one IP create exactly 3 workspaces (integration test)
- [ ] **Isolation:** a demo session for workspace A calling a scoped route with B's ID in the body or query still reads A only (test)
- [ ] **Cookie:** the `Set-Cookie` on the demo response has `HttpOnly`, `Secure` (production build), `SameSite=Lax` and the `__Host-` prefix (test)
- [ ] **CSRF:** a POST with a foreign `Origin`, or without `Idempotency-Key` → 403/400; an identical Idempotency-Key replay returns the stored response (tests)
- [ ] **Live proof:** one real magic-link email sent to an allowlisted address via Resend returns an email ID (logged, not the token), and the response is recorded to `fixtures/resend/send-email.json` with no key
- [ ] `./scripts/landing-checks.sh --fast` passes

## Deliverables
- `apps/web/src/app/api/auth/{magic-link,verify,sign-out}/route.ts`, `apps/web/src/app/api/demo/route.ts`
- `apps/web/src/server/{session.ts,csrf.ts,idempotency.ts,client-ip.ts,caps.ts}`
- `packages/adapters/src/email/{resend.ts,sender.ts,templates/magic-link.{en,hi}.ts}`
- `fixtures/resend/send-email.json`
- tests under `apps/web/test/auth/` and `packages/adapters/test/email/`

## Validation Gate
```bash
make reset && pnpm --filter @cleared/db run seed
pnpm --filter @cleared/web test -- auth 2>&1 | tee "$TMPDIR/m1-05-auth.log"
pnpm --filter @cleared/adapters test -- email 2>&1 | tee "$TMPDIR/m1-05-email.log"
pnpm --filter @cleared/web build && (pnpm --filter @cleared/web start > "$TMPDIR/m1-05-web.log" 2>&1 &) && sleep 8
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -H "origin: http://localhost:3000" -H "idempotency-key: k$i" http://localhost:3000/api/demo; done | tee "$TMPDIR/m1-05-caps.txt"
tail -1 "$TMPDIR/m1-05-caps.txt" | grep -q 429
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-07** builds the landing, sign-in and check-email pages on these routes and calls `requireSession` in the payments API.
- **M1-GATE** uses "Try as demo seller".
- **M2-02** reads `llm_budget_usd`. **M3-08** reuses `EmailSender` and the allowlist guard.
- **M4-05** extends the authZ tests.
