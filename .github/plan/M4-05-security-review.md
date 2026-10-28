---
title: "M4-05 · Security review (STRIDE doc, authZ + ownership tests, caps, file guards, dependency audit)"
milestone: "M4 · Trust & Global"
labels: ["security", "critical"]
blocked_by: ["M3-GATE"]
estimate: "4h"
resources: []
needs: []
---

## Context

Cleared files disputes on a seller's behalf and hosts a public demo where any visitor gets a workspace. A cross-workspace leak, a forged webhook or an exhausted LLM cap would take the demo down for every judge (B6 #1, #3, #13, #14). Architecture §8 holds the STRIDE model; this ticket turns each row into tests and closes the gaps. Rubric: Technological Implementation (production-grade), Stage One (a working demo through Dec 15).

## Scope

- **Threat model:** `docs/security/threat-model.md` expands architecture §8. It is a STRIDE table per trust boundary (browser | web | worker + DB | PayPal | OpenAI | Resend), with the control and the test that proves it. It also covers the OWASP Top 10 for web and for LLM applications, and lists the residual risks
- **AuthZ tests:** every API route and server action is run with workspace A's session against workspace B's IDs, and with no session.
  - expected: 404 (no existence leak) or 401
  - route coverage is enforced: a test enumerates the route manifest and fails on any route without an authZ case
- **Ownership tests:**
  - a webhook or poll result for a PayPal resource missing from `paypal_resource_owner` is quarantined and never shown
  - an approved action whose resource belongs to another workspace is refused at execution
  - a `custom_id` that disagrees with the owner row is quarantined
- **Caps tests:**
  - 3 demo workspaces per IP per day, 200 globally (`DEMO_WORKSPACES_PER_IP_PER_DAY`, `DEMO_WORKSPACES_GLOBAL_MAX`)
  - `LLM_WORKSPACE_CAP_USD` and `LLM_DAILY_CAP_USD` stop runs with a seller-facing message
  - the content-hash cache does not count against caps
  - `X-Forwarded-For` spoofing doesn't bypass the IP cap (only Render's proxy header is trusted)
- **File guard tests:** type sniffing beats the extension (a PDF renamed .png, an HTML polyglot); the 10 MB, 30-page and 25 MP caps; decompression-bomb images; encrypted or JavaScript-bearing PDFs; EXIF stripped on re-encode
- **Webhook and SSRF tests:** an invalid signature returns 400 quickly; a `cert_url` outside `api.paypal.com` / `api.sandbox.paypal.com` is rejected before any fetch; a replayed `transmission_id` is deduped
- **Session and magic-link tests:** cookie flags (`HttpOnly`, `Secure`, `SameSite=Lax`); magic links are single-use and expire after 15 min; CSRF protection on mutations; the Idempotency-Key is replay-safe
- **Headers:** CSP (no `unsafe-eval`; nonce scripts), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, asserted by a test
- **Governance:** with `AGENT_KILL_SWITCH=true`, every execution path is refused. The audit log role has no UPDATE or DELETE grant (a test tries both)
- **Supply chain:** `pnpm audit --prod --audit-level high` in CI (0 high or critical, or a documented exception with its expiry); `gitleaks detect` over the full git history; lockfile pinned; GitHub Actions pinned to commit SHAs
- Fix every critical and high finding in this ticket. Medium and low findings are fixed or logged in BL-01 with a reason

## Out of scope

- The retention purge job and its DB role (M4-07)
- Load and DoS capacity numbers (M4-06)
- Injection evals against the AI workflows (M4-02, adversarial set)

## Acceptance Criteria

- [ ] `pnpm test:security` passes: authZ, ownership, caps, files, webhook/SSRF, session, headers and governance suites, on fixture replay
- [ ] The route-coverage test fails when a planted route without an authZ case is added, and passes on the tree
- [ ] `pnpm audit --prod --audit-level high` exits 0, or every exception is listed in `docs/security/threat-model.md` with an expiry date
- [ ] `gitleaks detect --source . --log-opts="--all"` reports 0 leaks
- [ ] Every row of the STRIDE table names a test file that exists (`pnpm security:check-doc`)
- [ ] `curl -sI` against the local production build shows the CSP, HSTS and other required headers

## Deliverables

- `docs/security/threat-model.md`
- `apps/web/test/security/*.test.ts`, `apps/worker/test/security/*.test.ts`, `packages/db/test/grants.test.ts`
- `scripts/check-security-doc.ts`; the `audit` and `gitleaks` CI steps (hot file `.github/workflows/*`)
- Fixes in the affected modules

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
make up && pnpm db:migrate && pnpm db:seed
pnpm test:security
pnpm security:check-doc
pnpm audit --prod --audit-level high
gitleaks detect --source . --log-opts="--all" --report-path "$TMPDIR/gitleaks.json"
pnpm --filter @cleared/web build && (pnpm --filter @cleared/web start -p 3100 & echo $! > "$TMPDIR/web.pid")
for i in $(seq 1 30); do curl -sf localhost:3100/healthz >/dev/null && break; sleep 1; done
curl -sI localhost:3100/ | grep -Ei 'content-security-policy|strict-transport-security|x-content-type-options'
kill "$(cat "$TMPDIR/web.pid")"
```

## Handoff

- **M4-GATE** re-runs `pnpm test:security` and the audit from a clean state
- **M4-07** uses the threat model's residual-risk list in the runbook
- **M5-01** links `docs/security/threat-model.md` from the README Architecture section
