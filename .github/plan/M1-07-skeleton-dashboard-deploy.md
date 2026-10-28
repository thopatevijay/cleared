---
title: "M1-07 · Skeleton dashboard (payments list) deployed end to end on Render"
milestone: "M1 · Walking Skeleton"
labels: [frontend, infra, critical]
blocked_by: [M1-04, M1-05, M1-06]
estimate: "5h"
resources: [DEPLOY, PAYPAL_SANDBOX]
needs: []
---

## Context
The hackathon requires a **functional hosted demo**: mockups and "demo mode" don't count. This ticket is the first time the whole path runs on Render: a judge opens the URL, gets a demo workspace, makes a real sandbox payment, and sees it arrive through PayPal's webhook. It proves the architecture end to end early (**Technological Implementation**, **Presentation**) and sets the UI baseline every later screen builds on (**Design**). `PAYPAL_SANDBOX` is claimed because the deployed proof makes a live sandbox payment and receives its real webhook.

## Scope
- **Pages** (App Router, next-intl EN/HI, built to `docs/design/screens/landing.md` and the M1 subset of `dashboard.md`, using `apps/web/src/styles/tokens.css`):
  - `/[locale]`: landing with "Try as demo seller" (→ `POST /api/demo`) and the magic-link sign-in form. States: check-email, expired link, cap reached (429 copy), error
  - `/[locale]/payments`: the dashboard
    - the summary bar (held total, in-dispute count, proof-ready count; the M2/M3 parts show "—" with their spec copy)
    - payment rows: amount + currency, receivable amount + currency, status badge (icon + label + colour; PENDING shows `status_details.reason`), time in the workspace tz, and a "via webhook" source tag
    - the audit-log footer link (placeholder route per spec)
  - Proxy (Next 16 `proxy.ts`) redirects routes without a session to the landing page
- **States:**
  - loading (skeleton rows)
  - empty, with a **"Create a sandbox test payment" (Sandbox badge)** button → `POST /api/sandbox/test-payments` (requires `Idempotency-Key`, capped at 3 per workspace per day) → enqueues `sandbox.test_payment` (M1-04) → the row shows "Waiting for PayPal…" until the webhook lands
  - error, with the correlation ID
- **API:** `GET /api/payments?offset&limit` (zod contract in `packages/core`, `requireSession`, offset pagination ≤ 50), polled with SWR every 5 s while the tab is visible
- **i18n:** `apps/web/messages/{en,hi}.json` (hot file). Every new string in both; a language switch; `<html lang>` set per locale; numbers and currencies via `Intl`
- **Render** (`render.yaml`, hot file):
  - web: `preDeployCommand: pnpm --filter @cleared/db run migrate && pnpm --filter @cleared/db run seed` (extends M0-08), health check `/healthz`
  - worker: a background worker running `apps/worker`
  - Postgres in Oregon
  - env var keys from `.env.example` declared with `sync: false` (values set in the Render dashboard, never in the file)
  - `APP_BASE_URL` = the Render URL
  - confirm the client-IP header that Render sets (M1-05 helper) and record it in a code comment
- **Webhook URL:** confirm the app webhook registered by M1-04 `scripts/setup.ts` points at `$RENDER_WEB_URL/api/webhooks/paypal` and that `PAYPAL_WEBHOOK_ID` is set in the Render env (presence only), and record the webhook URL in `.dev-refs.md`
- **E2E:** `apps/web/e2e/skeleton.spec.ts` (Playwright + `@axe-core/playwright`), run locally and against the deployed URL via `E2E_BASE_URL`. Screenshots at 375/768/1440, light and dark, every state, saved under `.review/M1-07/` for `ui-reviewer`

## Out of scope
- Payment detail, proof pack, holds and disputes screens → M2-05, M2-09, M3-01
- The full Hindi review → M4-03; the a11y/perf audit → M4-04
- `/readyz`, Sentry and log redaction → M1-08
- The judge scenario runner (chargeback, sandbox decision) → M2-10

## Acceptance Criteria
- [ ] **Local E2E** (`make up`, web + worker, payment fixture replay through msw for PayPal): landing → demo → empty state → create test payment → the row appears with status COMPLETED, in EN and HI
- [ ] **Deployed E2E (live, PAYPAL_SANDBOX):** `E2E_BASE_URL=<render-url> pnpm --filter @cleared/web exec playwright test skeleton` runs: open URL → "Try as demo seller" → create a sandbox test payment → a COMPLETED row with "via webhook" appears within 2 min. The spec measures that time and prints it
- [ ] **Isolation on deploy:** a second demo context doesn't see the first one's payment (same spec)
- [ ] **axe:** zero serious or critical violations on every page and state (in the spec)
- [ ] **ui-reviewer** returns `VERDICT: PASS` on the `.review/M1-07/` screenshots against `docs/design/` (output pasted in the PR)
- [ ] **i18n:** `node scripts/check-messages.mjs` finds identical key sets in `en.json` and `hi.json` and no hard-coded user-visible strings in `apps/web/src/app/**` (the script greps JSX text nodes)
- [ ] **render.yaml:** contains no secret values (`check-no-secrets.sh` passes). `curl <render-url>/healthz` → 200
- [ ] `./scripts/landing-checks.sh` (full) passes

## Deliverables
- `apps/web/src/app/[locale]/{page.tsx,payments/page.tsx,layout.tsx}`, `apps/web/src/proxy.ts`
- `apps/web/src/components/{StatusBadge,MoneyCell,PaymentRow,SummaryBar,EmptyState,ErrorPanel,LanguageSwitch}.tsx`
- `apps/web/src/app/api/{payments,sandbox/test-payments}/route.ts`, `packages/core/src/contracts/payments.ts`
- `apps/web/messages/{en,hi}.json`, `scripts/check-messages.mjs`
- `render.yaml`, `apps/web/e2e/skeleton.spec.ts`, `apps/web/playwright.config.ts`
- `.review/M1-07/*` (screenshots, axe JSON; gitignored)

## Validation Gate
```bash
make reset && pnpm --filter @cleared/db run seed
pnpm --filter @cleared/web test 2>&1 | tee "$TMPDIR/m1-07-unit.log"
node scripts/check-messages.mjs
pnpm --filter @cleared/web build && pnpm --filter @cleared/web exec playwright test skeleton 2>&1 | tee "$TMPDIR/m1-07-e2e-local.log"
# deployed (DEPLOY + PAYPAL_SANDBOX claimed); RENDER_WEB_URL is the non-secret value in .env.example (M0-08)
RENDER_WEB_URL=$(grep -E "^RENDER_WEB_URL=" .env.example | cut -d= -f2-); test -n "$RENDER_WEB_URL"
curl -fsS "$RENDER_WEB_URL/healthz"
E2E_BASE_URL="$RENDER_WEB_URL" pnpm --filter @cleared/web exec playwright test skeleton 2>&1 | tee "$TMPDIR/m1-07-e2e-deployed.log"
grep -E "webhook_to_visible_ms=[0-9]+" "$TMPDIR/m1-07-e2e-deployed.log"
./scripts/landing-checks.sh
```

## Handoff
- **M1-GATE** reruns the deployed spec from a clean stack.
- **M2-05, M2-09, M3-01** add screens under `[locale]` and reuse the components.
- **M2-10** replaces the test-payment button with the judge scenario (keep the route for the owner).
- **M1-08** adds `/readyz`; the Render health check stays `/healthz`.
- **M4-03 and M4-04** audit the messages and pages.
