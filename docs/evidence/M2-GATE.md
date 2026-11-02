# M2-GATE · Dispute loop gate: evidence

Run 2026-11-02 on `main` @ `efa886b`, from a fresh clone into `$TMPDIR/m2-gate`, against the PayPal sandbox
and OpenAI. All personal data is synthetic. No secret values appear here; ids below are sandbox ids.

## Clean state

| Step | Result |
|---|---|
| `make down && make up` (volumes removed) | exit 0 |
| `pnpm db:migrate && pnpm db:seed` | exit 0 (12 migrations, 25 queues; seed 1 workspace, 1 user) |
| `./scripts/landing-checks.sh` (full) | exit 0 in 3 min 8 s: core 566, db 103, adapters 341 (+4 live skips), worker 96 (+3 live skips), web 187; 0 DB-test skips |
| `make reset` + `pnpm db:seed` before the live run | exit 0 (so the SQL checks read only the live run's rows) |
| `pnpm --filter @cleared/web build` | exit 0 (18 s) |

## Live judge run (`e2e/judge-dispute.live.spec.ts`)

**1 passed in 12.5 min**, as a judge would: new anonymous demo workspace, no keys in the browser, the real
pipeline (M2-03 extract, M2-04 scope check, M2-07 draft), the seller's **Approve** click on the M2-09 dispute
page, then the labelled "Simulate PayPal's decision (sandbox only)".

| | |
|---|---|
| workspace | `521920b9-cb45-4750-a538-6f8a4c8623b3` |
| scenario | `dd1783f6-9cb8-4602-b9bd-425e242905c4` |
| order | `9WW3702972587024S` |
| capture | `5EU372193D3382244` (`custom_id` = workspace) |
| dispute | `PP-R-VWV-10195862` |
| proof pack | `8f712ef9-89d9-4343-ad2a-db2906556eca` (3 items) |
| action | `bc3571f7-ef9b-4f91-b930-1d5c989b5b27` (`provide_evidence`, fingerprint `aa06f748`) |

Milestones (UTC, test start 03:10:04):

| Milestone | Time |
|---|---|
| order + capture (`COMPLETED`) | 03:10:19 |
| chargeback opened | 03:10:26 |
| hold seen: capture `PENDING / BUYER_COMPLAINT` | 03:13:41 |
| evidence step (`WAITING_FOR_SELLER_RESPONSE`) | 03:14:15 |
| real draft ready | 03:14:25 |
| seller approved (click) | 03:14:28 |
| evidence filed (PayPal 2xx) | 03:14:34 |
| decision offered / requested (sandbox only) | 03:18:08 |
| capture back to `COMPLETED` | 03:19:41 |
| dispute `RESOLVED`; hold released | 03:22:33 |

## Demo-level checks (on the run's data, scoped to the workspace)

1. **Ownership:** `paypal_resource_owner`: order 1, capture 1, dispute 1. PASS
2. **Chargeback → hold:** dispute mirrored; scenario timeline recorded the capture `PENDING / BUYER_COMPLAINT` at 03:13:41. PASS
3. **Proof pack:** 6 scope lines: `met` ×3, each with a stored citation (stored citations have passed the M2-04 verbatim check); `unverifiable` ×3 (`model_unverifiable`), none `met` without a citation. PASS
4. **Draft:** the spec asserts notes ≤ 2000 code points, one compiled PDF < 10 MB, and the evidence type per the reason map against PayPal's requested type. PASS
5. **Approval and execution:** audit trail for the action: `action.proposed` (agent) → `action.approved` (seller) → 6 × `action.check` → `action.sent` → `action.succeeded` (10 rows). PASS
6. **Evidence filed:** `action.sent` returned 2xx with a debug_id; action `succeeded`. PASS
7. **Decision:** labelled "Simulate PayPal's decision (sandbox only)"; dispute `RESOLVED`, outcome `RESOLVED_WITH_PAYOUT`; the UI wording is asserted by the spec ("you keep the money (PayPal covered the case)", never "won"). PASS
8. **Hold released:** capture `COMPLETED`; "Hold released" shown. PASS

Negative checks: `pnpm --filter ./apps/worker exec vitest run -t "isolation|kill switch"`: 3 passed. The forbidden-copy grep (`seller won|you won`) finds nothing.

## Cost

| task | model | cost USD |
|---|---|---|
| extract ×3 | gpt-6-luna | 0.00060 |
| check_scope | gpt-6.1-terra | 0.00701 |
| draft_dispute ×2 (supporting info at UNDER_REVIEW, evidence at WAITING_FOR_SELLER_RESPONSE) | gpt-6.1-terra | 0.00756 |
| **run total** | | **0.01517** (cap `LLM_WORKSPACE_CAP_USD` $0.10) |

PayPal sandbox: $0.

## Deviations from the written Validation Gate

- The gate's separate `pnpm … start` line for web and worker was **not** run: `apps/web/playwright.config.ts` starts its own `next start` and worker in live mode (`reuseExistingServer: false`), so both would clash and two workers would consume the same jobs (BL-01 6568051784).
- Added `make reset` + seed after the landing checks (they write test rows into the same database) and `pnpm --filter @cleared/web build` before the live run (a fresh clone has no production build). The first attempt without the build failed at `next start`.
- The SQL lines were scoped to the run's workspace, and the dispute query orders by `synced_at` (the table has no `updated_at`).

## Findings

- Local live runs deliver webhooks to the Render worker (one app-scoped webhook), which correctly quarantines the locally owned resources and raises Sentry **warnings** (CLEARED-1, CLEARED-2): BL-01 6568286398. No Sentry errors.
- `action.proposed` outbox rows are never published (no queue registered): BL-01 6568052054.
- The supporting-info proposal from the UNDER_REVIEW stage stays `proposed` after resolution (hidden in the UI).
