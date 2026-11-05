# Threat model

This document expands [architecture §8](../architecture.md#8-security) (M4-05). Every STRIDE row names
the control and the test that proves it. `pnpm security:check-doc` (`scripts/check-security-doc.ts`) fails
when a row names no test file, or a file that doesn't exist. `pnpm test:security` runs every suite named
here on recorded fixtures (no live PayPal, OpenAI or Resend call).

**Scope:** the hosted demo and the seller app. That is the browser, the Next.js web service, the pg-boss
worker, Postgres, and the three vendors (PayPal sandbox, OpenAI, Resend). Retention purge (M4-07),
capacity numbers (M4-06) and the adversarial AI eval set (M4-02) are out of scope here.

**Assets:** workspace data (payments, holds, disputes, evidence, audit trail), the seller session, the
PayPal app credentials, the OpenAI budget, and the demo's availability for judges through 2026-12-15.

## Trust boundaries

```
browser ──(1)── web (Next.js, Render) ──(2)── Postgres ──(2)── worker (pg-boss)
                    │  ▲                                        │   │   │
                    │  └──(3) PayPal webhooks                   │   │   └──(5) Resend
                    └──────────(3) PayPal REST ◄────────────────┘   └──(4) OpenAI
```

1. **Browser ↔ web:** anonymous and signed-in visitors, the public demo, the public acknowledgement link.
2. **Web/worker ↔ DB:** one app role; every workspace query is scoped by the session's `workspace_id`.
3. **PayPal:** inbound webhooks (forgeable by anyone) and outbound REST (orders, captures, disputes).
4. **OpenAI:** evidence goes out as data; model output comes back untrusted.
5. **Resend:** the magic-link email.

## STRIDE · 1. Browser ↔ web

| ID | STRIDE | Threat | Control | Test |
|---|---|---|---|---|
| B-1 | Spoofing | A stolen or forged session cookie | `__Host-` cookie, `HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain; 32-byte random token, only its sha256 stored; 30-day session with sliding renewal | `apps/web/test/auth/units.test.ts` `apps/web/test/auth/demo.int.test.ts` `apps/web/test/auth/isolation.int.test.ts` |
| B-2 | Spoofing | A replayed or old magic link | Single use (`used_at` set in the consuming UPDATE), expires after 15 min, same response whether or not the email exists | `apps/web/test/auth/magic-link.int.test.ts` |
| B-3 | Tampering | Cross-site request forgery on a mutation | `checkMutation`: JSON or multipart only (415), `Origin` must equal `APP_BASE_URL` (403), Idempotency-Key required (400) before the session is read | `apps/web/test/auth/units.test.ts` `apps/web/test/auth/demo.int.test.ts` `apps/web/test/security/authz.test.ts` |
| B-4 | Tampering | A retried or replayed mutation acts twice | Idempotency store: a replay returns the stored response (`idempotent-replay: true`); one in flight gets 409; Set-Cookie is never stored | `apps/web/test/auth/demo.int.test.ts` |
| B-5 | Information disclosure | Workspace A reads or changes B's data by id | Every route takes the workspace from the session only; a foreign id is a 404 (no existence leak); no session is a 401. Route coverage: a route with no authZ case fails the suite | `apps/web/test/security/authz.test.ts` `apps/web/test/auth/isolation.int.test.ts` |
| B-6 | Information disclosure | The acknowledgement token leaks via Referer or search engines | `/ack/<token>`: strict nonce CSP (`connect-src 'self'`; the browser Sentry SDK never loads there, so no error event or metric carries the URL out, BL-01 6649565909), `Referrer-Policy: no-referrer`, `noindex`, `no-store`; one neutral 404 for expired, revoked, scope-changed and unknown tokens | `apps/web/test/ack.int.test.ts` `apps/web/test/security/headers.test.ts` |
| B-7 | Elevation of privilege | XSS through evidence text or model output | React escapes everything; model output and evidence render as plain text; no `dangerouslySetInnerHTML`; nonce CSP with no `unsafe-eval` and no `unsafe-inline` scripts | `apps/web/app/api/notifications/notifications.int.test.ts` `apps/web/test/security/headers.test.ts` `apps/web/e2e/csp.spec.ts` |
| B-8 | Elevation of privilege | Clickjacking, MIME sniffing, downgrade to http | `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `nosniff`, HSTS 2 years, `Referrer-Policy: strict-origin-when-cross-origin`, on every response | `apps/web/test/security/headers.test.ts` |
| B-9 | Elevation of privilege | Third-party script from the Bryntum trial (GTM, `bryntum.com/verify`) | `script-src 'self' 'nonce-…'` without `strict-dynamic`, `connect-src 'self'`: an injected host is refused. Bryntum itself is same-origin (`/vendor/`) | `apps/web/e2e/csp.spec.ts` `apps/web/e2e/cash-calendar.spec.ts` |
| B-10 | Denial of service | Demo-workspace flooding | 3 per IP per day, 200 live globally, under an advisory lock (10 concurrent requests make exactly 3) | `apps/web/test/auth/demo.int.test.ts` `apps/web/test/security/caps.test.ts` |
| B-11 | Denial of service | A forged `X-Forwarded-For` to step around the per-IP cap | Only Render's `True-Client-IP` (set at its Cloudflare edge) or the last XFF hop (appended by Render's proxy) count; the client's own hops are ignored | `apps/web/test/security/caps.test.ts` |
| B-12 | Denial of service | Evidence upload bombs | Body read capped before parsing; 10 MB per file, 30 pages, 25 MP from the header before decoding; 50 items per pack, 200 MB per workspace | `apps/web/test/evidence.int.test.ts` `packages/adapters/src/files/prepare.test.ts` |
| B-13 | Tampering | A file disguised as another type (PDF named .png, HTML polyglot) | Sniffed type beats the extension; images re-encoded (trailing bytes and EXIF dropped); PDFs re-saved without JavaScript, OpenAction, attachments or annotations; encrypted PDFs refused; served as attachment with `nosniff` | `packages/adapters/src/files/sniff.test.ts` `packages/adapters/src/files/reencode.test.ts` `apps/web/test/evidence.int.test.ts` |

## STRIDE · 2. Web and worker ↔ database

| ID | STRIDE | Threat | Control | Test |
|---|---|---|---|---|
| D-1 | Repudiation | "I never approved that"; an audit row is edited | `audit_log`: no UPDATE, DELETE or TRUNCATE grant for the app role or PUBLIC (0006), plus the append-only trigger (0002) that stops a superuser too | `packages/db/test/grants.test.ts` |
| D-2 | Tampering | Evidence or an acknowledged scope check is changed after the fact | Append-only triggers on `evidence_items` and `scope_checks` | `packages/db/test/grants.test.ts` `packages/db/test/constraints.test.ts` |
| D-3 | Tampering | A draft changed after the seller approved it | The approval is bound to the payload sha256; execution recomputes it and refuses `PAYLOAD_CHANGED` | `apps/worker/src/jobs/execute-action.int.test.ts` `packages/core/src/actions/checks.test.ts` |
| D-4 | Elevation of privilege | The agent acts on its own | The agent can only insert `proposed_actions`; execution needs a seller approval; policy in code; dispute actions only from the dispute's live HATEOAS links and never after `seller_response_due_date − 1 h` | `packages/core/src/actions/checks.test.ts` `apps/worker/src/jobs/execute-action.int.test.ts` |
| D-5 | Elevation of privilege | An incident needs every execution stopped | Kill switch: `AGENT_KILL_SWITCH` env or the `platform_flags` DB flag. Every executable kind (`EXECUTABLE_KINDS`) is refused `KILL_SWITCH` before any PayPal request; no agent run calls a model | `apps/worker/test/security/governance.test.ts` `packages/core/test/agent/harness.test.ts` |
| D-6 | Repudiation | Synthetic-workspace purge deletes audit rows | Only rows of a workspace flagged `synthetic = true` (`FOR UPDATE`), guards lifted and restored in one transaction, refused when the role doesn't own the tables (accepted design A-2) | `packages/db/test/ops.test.ts` |

## STRIDE · 3. PayPal

| ID | STRIDE | Threat | Control | Test |
|---|---|---|---|---|
| P-1 | Spoofing | A forged webhook | Self-verified signature (CRC32 + RSA-SHA256 over the raw body) against our `PAYPAL_WEBHOOK_ID`; 5 min clock skew; a bad signature is 401 at once and never falls back to the API | `apps/web/test/webhooks/paypal-webhook.int.test.ts` `packages/adapters/src/paypal/webhook-verify.test.ts` |
| P-2 | Spoofing | SSRF through `paypal-cert-url` | Rejected before any fetch unless `https://api.paypal.com` or `https://api.sandbox.paypal.com` (the env's own host), no IP literal, port or userinfo; redirects are not followed | `apps/web/test/webhooks/paypal-webhook.int.test.ts` `packages/adapters/test/paypal/webhook-ingest.test.ts` |
| P-3 | Tampering | A replayed delivery (same `transmission_id`) or out-of-order events | Unique `(provider, event_id)`: a replay is acked and dropped (5 concurrent posts → 1 row, 1 job). PayPal's own retries reuse the event id with a new transmission id, so the event id is the stronger key. Every event re-fetches the resource, so order never matters | `apps/web/test/webhooks/paypal-webhook.int.test.ts` `packages/db/test/constraints.test.ts` |
| P-4 | Information disclosure | A resource of another workspace (or another environment) shows up | `paypal_resource_owner` + `custom_id`: a mismatch is quarantined at once; an unowned resource after a 10-minute window; the poll path only fetches owned resources | `apps/worker/test/jobs/capture-sync.test.ts` `apps/worker/src/jobs/dispute-sync.int.test.ts` `apps/worker/src/jobs/reconcile.int.test.ts` `packages/core/test/accounts.test.ts` |
| P-5 | Elevation of privilege | An approved action executed against another workspace's resource | Ownership re-checked at execution: `NOT_OWNED`, no PayPal request | `apps/worker/src/jobs/execute-action.int.test.ts` `apps/worker/src/actions/add-tracking.int.test.ts` `apps/worker/src/actions/record-service-completed.int.test.ts` |
| P-6 | Denial of service | PayPal slow or down | Shared HTTP client: timeout, retries only on timeout/5xx/429 with jitter and `Retry-After`, circuit breaker; webhook acks after the raw insert | `packages/adapters/src/http/client.test.ts` `apps/web/test/webhooks/ack-time.int.test.ts` |

## STRIDE · 4. OpenAI

| ID | STRIDE | Threat | Control | Test |
|---|---|---|---|---|
| O-1 | Elevation of privilege | Prompt injection in evidence steers the agent | Evidence travels only in delimited data blocks with an injection scan; instructions never contain evidence; output schema-validated; the agent can only propose | `packages/core/test/agent/injection.test.ts` `packages/core/test/agent/harness.test.ts` |
| O-2 | Denial of service | The LLM budget is exhausted (one workspace or the day) | $0.10 per demo workspace, $1 per UTC day globally, exact micro-dollar compare. Each call's worst case (`max_output_tokens` × output price + an input bound) is reserved under one lock before sending and settled after, so no call crosses a cap and concurrent runs see each other's reservations | `packages/core/test/agent/units.test.ts` `apps/worker/test/agent-harness.test.ts` `packages/adapters/src/ai/worst-case.test.ts` |
| O-3 | Denial of service | The cache is abused to spend budget | Content-hash cache: a hit is recorded as `cache_hit` at cost 0 and never counts against a cap | `packages/db/test/agent-runs.test.ts` `apps/worker/test/agent-harness.test.ts` |
| O-4 | Information disclosure | The seller is not told why AI stopped | Seller-facing messages: scenario start refused at the daily cap (`llm_cap_reached`), pack banner, draft "budget used up" | `apps/web/app/api/scenarios/scenarios.int.test.ts` `apps/worker/src/jobs/explain-hold.int.test.ts` |

## STRIDE · 5. Resend

| ID | STRIDE | Threat | Control | Test |
|---|---|---|---|---|
| R-1 | Spoofing | The app emails anyone (spam relay, phishing) | Recipient guard: only `EMAIL_RECIPIENT_ALLOWLIST`; a refused address gets the same response | `apps/web/test/auth/magic-link.int.test.ts` |
| R-2 | Denial of service | Magic-link flooding | 5 per email and 20 per IP per hour (no lock: accepted limitation L-3) | `apps/web/test/auth/magic-link.int.test.ts` |
| R-3 | Information disclosure | A sign-in token or email in logs or Sentry | Only token hashes are stored; Sentry events carry the correlation id, never the email or the cookie | `apps/web/test/sentry.test.ts` |

## OWASP Top 10 (web, 2021)

| # | Risk | Where it is handled |
|---|---|---|
| A01 | Broken access control | B-5, D-4, P-4, P-5 (authZ suite with route coverage) |
| A02 | Cryptographic failures | B-1, B-8 (HSTS; tokens are 32 random bytes, stored hashed) |
| A03 | Injection | Drizzle parameterised SQL only; zod at every trust boundary; B-7 |
| A04 | Insecure design | ADR 0010: propose-only agent, approval bound to the hash, kill switch (D-3 to D-5) |
| A05 | Security misconfiguration | B-8, B-9; `PAYPAL_ENV=live` refused at startup; no PR previews |
| A06 | Vulnerable components | `pnpm audit --prod --audit-level high` in CI (0 high); exceptions below |
| A07 | Identification and authentication failures | B-1, B-2, R-2 |
| A08 | Software and data integrity failures | P-1, D-1, D-2; actions pinned to commit SHAs; frozen lockfile; gitleaks over the full history |
| A09 | Logging and monitoring failures | Append-only audit log; pino request lines with correlation ids; Sentry; quarantine warnings |
| A10 | SSRF | P-2; outbound hosts are fixed per vendor in the adapters |

## OWASP Top 10 for LLM applications (2025)

| # | Risk | Where it is handled |
|---|---|---|
| LLM01 | Prompt injection | O-1 |
| LLM02 | Sensitive information disclosure | Synthetic personal data only; evidence of one workspace per run; R-3 |
| LLM03 | Supply chain | One vendor (OpenAI) behind our adapter; no third-party models or plugins |
| LLM04 | Data and model poisoning | No training or fine-tuning; evals gate prompt/model/schema changes |
| LLM05 | Improper output handling | Schema-validated output, citations checked against the evidence, plain-text rendering (B-7) |
| LLM06 | Excessive agency | Propose-only; seller approval bound to the hash; kill switch (D-4, D-5) |
| LLM07 | System prompt leakage | Prompts hold no secrets; they are public in the repo |
| LLM08 | Vector and embedding weaknesses | Not applicable: no retrieval store |
| LLM09 | Misinformation | Citations required; estimates labelled with their source; "seller keeps the money", never "won" |
| LLM10 | Unbounded consumption | O-2, O-3; ≤ 6 calls per run, token and wall-clock limits |

## Supply chain

- `pnpm audit --prod --audit-level high` runs in CI (`.github/workflows/ci.yml`, job `security`). On
  2026-11-03 it reported 0 high and 0 critical.
- `gitleaks detect` runs over the full git history in CI (pinned version, checksum verified). On
  2026-11-03 it scanned 174 commits and found no leaks.
- `pnpm-lock.yaml` is frozen in CI. Every GitHub Action is pinned to a commit SHA.

### Dependency audit exceptions

Neither entry is high or critical, so neither fails the CI gate. Both are listed here so the next
review sees them.

| Advisory | Package | Severity | Path | Why it stays | Review by |
|---|---|---|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | glob | moderate | `@sentry/nextjs` → `@sentry/bundler-plugins` | build time only (source-map upload); never runs in a request | 2026-12-15 |
| GHSA-g3hv-75wg-m249 | minimatch | moderate | `@sentry/nextjs` → `@sentry/bundler-plugins` | build time only | 2026-12-15 |

## Accepted designs

| ID | Decision | Why |
|---|---|---|
| A-1 | The magic-link email is sent inside the request (BL-01 6528459128) | Owner decision 2026-11-03. A job would store the raw sign-in token at rest in `pgboss.job`. The cost is latency: up to about 30 s when Resend is slow, with an unchanged response. The hosted demo path sends no email |
| A-2 | The synthetic-workspace purge lifts the append-only guards inside one transaction (BL-01 6572922203) | Limited to `synthetic = true` rows under `FOR UPDATE`; the triggers and grants are restored before commit; refused up front when the role doesn't own the tables (the rows then stay flagged for M4-07's purge) |
| A-3 | `style-src 'unsafe-inline'` | React `style` props and Bryntum's runtime styles need it. It allows no script execution (scripts are nonce-only) |
| A-4 | The seller's own reply notes skip the `foreign_contact` check (BL-01 6539205408) | The check guards model output against injected contacts. The seller authored this text and approves the exact payload and its fingerprint |
| A-5 | The acknowledgement link (BL-01 6569233475) | The recorded IP is the one Render saw (`clientIp`), never the client's first XFF hop. One neutral 404 for every unusable token |
| A-6 | `POST /api/ack/:token` takes no Idempotency-Key | Accepting is a state transition on the link, so a second submit is a no-op and a replay changes nothing (`apps/web/test/ack.int.test.ts`, AC1) |
| A-7 | The kill switch stops executions of seller-approved actions and every AI run (ADR 0010) | The sandbox scenario simulator (test payment, buyer chargeback, PayPal's decision) role-plays the buyer and PayPal in the sandbox only and is not an execution on the seller's behalf (BL-01 finding, owner to confirm) |

## Residual risks

M4-07's runbook uses this list.

| ID | Risk | Bound or mitigation |
|---|---|---|
| L-1 | The worst-case reservation estimates images and PDFs (OpenAI's per-image patch cap; one page per 50 KB, at most 30 pages). Text is a true upper bound | A wrong estimate can overshoot a cap by at most that call's input under-estimate. Output, the larger part, is bounded exactly |
| L-2 | A reservation whose call never answers (process crash, a late answer that never lands) stays counted | It fails closed: the cap is reached earlier, never later |
| L-3 | Magic-link and acknowledgement-link rate limits count without a lock (BL-01 6528459846, 6569233475) | A concurrent burst can overshoot by a few. Bounded by the recipient allowlist and Resend's own limits |
| L-4 | Confirmed (#168): Render sets `True-Client-IP` in production (10/10 `demo client ip source` log lines, 2026-11-05; BL-01 6530992863). Visitors behind one NAT share one bucket of 3 demos per rolling 24 h | Fails closed, not open; the 429 says when the next slot frees (BL-01 6649565560) |
| L-5 | `@cleared/core`'s barrel pulls a crypto polyfill (asn1.js) into client chunks. It probes `eval`, which the CSP refuses, and asn1.js then takes its fallback | No script runs. It costs about 0.7 MB of client JavaScript (BL-01 finding) |
| L-6 | Moderate advisories in the Sentry build plugin | Build time only; see the exceptions above |
| L-7 | The Bryntum trial's GTM snippet on the Render host | Refused by the CSP (B-9). Whether it fires there is observed at M4-GATE |
