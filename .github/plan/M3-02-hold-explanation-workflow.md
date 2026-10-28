---
title: "M3-02 · Hold explanation workflow (grounded, EN/HI)"
milestone: "M3 · Holds & Cash"
labels: [agent, backend]
blocked_by: [M3-01]
estimate: "3h"
resources: [OPENAI]
needs: []
---

## Context
Sellers say holds come "with very little transparency". The storyboard (0:45–1:05) shows a real sandbox payment under review, **explained in Hindi**. This is the `explain_hold` workflow from ADR 0009 (small model, grounded in the cited rule table). It is one of the three gold sets (hold explanations, target ≥ 95%, M4-01). It feeds **Potential Impact** and **Design** (global, multilingual), and **Tech** (a guarded AI workflow).

## Scope
- `explain_hold` workflow on the M2-02 harness (`AiProvider` adapter on `openai`, model `OPENAI_MODEL_SMALL`, structured output from a zod schema via `z.toJSONSchema`).
- **Input** (grounded, data-delimited):
  - the hold fields (reason, amount, currency, opened_at)
  - the M3-01 rule row (id, quote, url)
  - the code-computed estimated date
  - the seller locale (`en` | `hi`)
  - no evidence text and no buyer text
- **Output schema:** `{ summary, whatPayPalIsDoing, whatYouCanDo: string[] (≤3), ruleId }`.
- **Output guardrails:**
  - the schema is valid
  - `ruleId` equals the input rule id
  - no date, number or amount appears that isn't in the input (a deterministic check)
  - no promise words ("guaranteed", "will release" without "estimated"), as a check list per locale
  - Any failure retries once, then falls back.
- **Code, not the model, inserts the estimated date and the source link.** The UI renders the text as plain text.
- **Fallback when AI is down, over budget or the kill switch is on:** static EN/HI template text per rule row. The UI labels which one it is ("AI explanation" vs "standard explanation").
- **Limits:**
  - per-run limits (≤ 2 calls, token caps)
  - per-workspace ($0.10) and global ($1/day) budgets from the harness
  - a content-hash cache keyed on (rule id, reason, locale, prompt version): identical holds cost nothing
- Write `explanations` (hold_id, locale, text, source_ref). Moving the Hold to `explained` and writing the outbox row happen in one transaction. Re-explanation is triggered by a locale change.
- Fixture-replay tests use recorded responses under `fixtures/openai/explain_hold/` (recorded in this ticket with OPENAI; the live calls are limited to recording them and proving the ACs).
- Hold detail (M3-01) shows the explanation and a locale toggle (EN/HI).

## Out of scope
- Gold set + live eval suite: M4-01, M4-02
- UI chrome translation and number/date formatting: M4-03
- Dispute drafting: M2-07

## Acceptance Criteria
- [ ] Fixture replay: for the `payment_review` and `dispute_hold` rules in EN and HI, the output passes every guardrail and `ruleId` matches
- [ ] An injected fixture with a fabricated date ("released on 3 Nov") is rejected by the guardrail, and the fallback text is stored with `source_ref` = rule id
- [ ] With `AGENT_KILL_SWITCH=true` or a zero budget, no model call is made and the fallback is used (test asserts 0 provider calls)
- [ ] A second identical hold hits the cache (0 tokens recorded in `agent_runs`)
- [ ] Live (OPENAI): one EN and one HI explanation for a `PENDING_REVIEW` hold. The run is recorded in `agent_runs` with tokens, cost and latency; the cost per explanation is noted in the PR
- [ ] The rendered explanation is plain text (an HTML-in-output fixture renders escaped)

## Deliverables
- `packages/core/src/ai/explain-hold/{schema.ts,guardrails.ts,fallback.ts}` (+ tests)
- `packages/adapters/src/ai/workflows/explain-hold.ts`, `apps/worker/src/jobs/explain-hold.ts`
- `fixtures/openai/explain_hold/*.json`
- `apps/web/components/holds/explanation.tsx`, message keys

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- explain-hold
pnpm --filter ./apps/worker test -- explain-hold
ls fixtures/openai/explain_hold/ | tee "$TMPDIR/m3-02-fixtures.txt" | wc -l
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-08 alert emails reuse the explanation summary (or the fallback)
- M4-01 builds the 20-case hold gold set on this schema; M4-02 runs it; M4-03 formats dates in the text
- M3-11 shows the Hindi explanation on production
