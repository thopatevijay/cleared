# M3-GATE evidence (2026-11-03)

**Result:** passed with owner-waived ACs. The production run (ACs 2–3) was **carried forward to M4-GATE (#52)** by owner decision on 2026-11-03 ("don't pause … carry forward to next milestone's last ticket and keep going"). Nothing here claims that the gate's production run happened.

- Main: `ecdb27f`
- Render web and worker: live on `ecdb27f`

## Acceptance criteria

| # | AC | Result | Evidence |
|---|---|---|---|
| 1 | Local clean-state run: landing checks (full) and `check-plan.py` | **PASS** | Empty database (volume dropped): 19 migrations, seed 1 workspace and 1 user. Landing checks exit 0: core 778, db 112, adapters 347 (+4 live), worker 169 (+10 live), web 262. `check-plan.py`: no problems (58 tickets). Re-run on `ecdb27f` after #131: green, worker 170. |
| 2 | Production checks 1–9, recorded here with IDs, `debug_id`s, timings and sources | **CARRIED → M4-GATE (#52)** | Not run as the gate's clean production run. Closest evidence: the M3-11 run 3 on production (`a5dda9b`, 2026-11-03 06:37–06:52Z), in `docs/evidence/m3-storyboard-dry-run.md`, passed checks 1, 2, 3, 5 (without email), 6, 7 and 8. Not covered there: check 4's secondary trackers-batch record and check 9's private window (both added in #131 and never run live), and check 5's email (needs the owner's allowlisted workspace). |
| 3 | Production Playwright storyboard passes for the automated steps | **CARRIED → M4-GATE (#52)** | M3-11 run 3: `1 passed (14.6m)` on `a5dda9b`. The `ecdb27f` spec (with the #131 additions) hasn't been run on production. |
| 4 | Latest `ops_checks` rows all show `pass = true` | **PASS** | 2026-11-03 09:15:29Z: reconcile ✓ (6), `approved_to_paypal_p99` 1.806 s < 300 ✓, `hold_visible_p99` 2.658 s < 120 ✓ (after the #131 measurement fix; it was 201 s), `missed_deadlines` 0 ✓, `synthetic_fresh` 21,743 s < 93,600 ✓ (the first synthetic run passed at 03:13Z, in 751.7 s). |
| 5 | No secrets in the evidence files | **PASS** | `./scripts/check-no-secrets.sh` exit 0. |

## Carried to M4-GATE (#52): run on production from a clean state
1. A new video-pool review-hold payment, approved by the owner (P-52), then captured and assigned over `render ssh`.
2. `E2E_BASE_URL=https://cleared-web-gd1b.onrender.com pnpm --filter ./apps/web exec playwright test e2e/storyboard.spec.ts`, which needs one fresh demo workspace (quota: 3 per IP per day). This covers checks 1–4 and 6–9, including the trackers-batch record on a disputed capture. That call is unproven live; if PayPal refuses it, record it as a finding.
3. Check 5's email: a chargeback in the owner's own allowlisted workspace, with the bell and Resend "delivered" confirmed.
4. Record every scene with sandbox IDs, `debug_id`s, timings and the state-change source.
