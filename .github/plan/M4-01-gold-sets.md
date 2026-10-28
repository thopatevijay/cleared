---
title: "M4-01 · Gold sets (extraction 30, scope 40, hold 20; synthetic; owner labels; second-model review)"
milestone: "M4 · Trust & Global"
labels: ["eval", "owner"]
blocked_by: ["M3-GATE"]
estimate: "6h"
resources: ["OPENAI"]
needs: []
---

## Context

Accuracy claims are only credible against labelled ground truth (B6 #10; CLAUDE.md "Claims discipline"). The README, the video (2:15–2:40) and the Devpost text quote measured numbers with *n*; this ticket creates the three gold sets those numbers come from. Rubric: Technological Implementation (a tested AI workflow), Potential Impact (measured results), Presentation (honest numbers). All personal data is synthetic (PROJECT.md §9.1).

## Scope

- **Format (ContractNLI-style)**, one zod schema per set in `packages/evals/src/gold/schema.ts`, shared by M4-02:
  - each item: `id`, `split` (`dev` | `test`), `locale`, `persona` (synthetic: country, trade), `documents[]` (`doc_id`, `kind` = the `evidence_items.kind` values, `text`)
  - label: `met` | `partial` | `missing` | `unverifiable`, plus `spans[]` (`doc_id`, `start`, `end`, `quote`); `unverifiable` has no spans
- **Extraction (30):** chats, briefs, invoices and receipts with the expected facts (amount and currency, deliverables, dates, parties, tracking number and carrier). Each fact has its source span
- **Scope (40):** one scope document plus delivery evidence. Each scope line (hypothesis) gets a label and spans. Every label has at least 8 items. At least 5 items contain injection text in buyer-written evidence, labelled as if the text were absent (M4-02 reuses them)
- **Hold explanations (20):** a capture `PENDING` + `status_details.reason` case (PENDING_REVIEW, BUYER_COMPLAINT, and the badged sample scenarios). Each case names the expected rule-table entry (M3-01), the required facts, and the claims it must never make ("guaranteed release", "seller won", an exact release date without "estimated"). 10 EN and 10 HI
- **Spread:** personas from India, Kenya, Nigeria, Indonesia and the Philippines; some Hinglish evidence; goods and services; USD, EUR, INR, JPY
- **Split:** about 25% `dev` (for prompt work) and 75% `test` (reported). The split is fixed by a seeded hash of `id`
- **Process:**
  1. `pnpm eval:draft` drafts **unlabelled** synthetic cases with `OPENAI_MODEL_LARGE`. The generator prompt and model ID are stored next to the data
  2. The **owner labels** every item with `pnpm eval:label`, a terminal tool that shows each item and records the label, spans (selected by quote, offsets computed) and a note. This step carries the `owner` label
  3. A **second model** labels independently with `pnpm eval:review`. Its model differs from the one the workflow under test uses for that task
  4. Disagreements are written to `disagreements.jsonl`: both labels, the owner's final decision and the reason. Owner vs second-model agreement is reported as Cohen's kappa per set
- `pnpm eval:validate` checks every span (verbatim at its offsets), the counts, the per-label minimums, the split ratio and the schema
- The spend of each run is recorded in `packages/evals/gold/SPEND.md` (tokens and USD, from `agent_runs`-style accounting) and stays within the OPENAI budget

## Out of scope

- The eval runner, the CI replay, the live workflow and the metrics report (M4-02)
- Changing the workflow prompts (M2-03, M2-04, M3-02 own them; changes go through M4-02's eval gate)
- Dispute-draft quality evals beyond the trajectory checks (M4-02)

## Acceptance Criteria

- [ ] `pnpm eval:validate` exits 0. It prints the counts: extraction 30, scope 40, holds 20. Every label has ≥ 8 scope items, there are ≥ 5 injection items, and holds split 10 EN / 10 HI
- [ ] Every span's `quote` equals `text.slice(start, end)` of its document (validated by the script; 0 mismatches)
- [ ] Every item has `labelled_by: "owner"`, plus a `review` record from a model ID that differs from the task's production model (validated)
- [ ] `disagreements.jsonl` has one row per disagreement, each with a final decision and reason. Kappa per set is printed by `pnpm eval:validate`
- [ ] A PII scan (`pnpm eval:validate --pii`) finds no real-looking emails, phone numbers or PayPal IDs outside the reserved synthetic patterns (`example.com`, `+91-00000-…`)
- [ ] Recorded generator and reviewer responses are saved under `fixtures/openai/gold/`, so drafting replays without spend (`pnpm eval:draft --replay` produces byte-identical output)
- [ ] The spend recorded in `SPEND.md` is ≤ the OPENAI daily budget on each day it ran

## Deliverables

- `packages/evals/package.json`, `packages/evals/src/gold/{schema,draft,label,review,validate}.ts`
- `packages/evals/gold/{extraction,scope,holds}.jsonl`, `packages/evals/gold/disagreements.jsonl`, `packages/evals/gold/README.md` (method, generator prompt, models, kappa), `packages/evals/gold/SPEND.md`
- `fixtures/openai/gold/*.json`

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter @cleared/evals typecheck
pnpm --filter @cleared/evals test
pnpm eval:validate | tee "$TMPDIR/gold-validate.txt"
pnpm eval:validate --pii
grep -E 'extraction: 30 .*scope: 40 .*holds: 20' "$TMPDIR/gold-validate.txt"
out=$(mktemp -d "$TMPDIR/gold.XXXX"); pnpm eval:draft --replay --out "$out"
diff -r "$out" packages/evals/gold/drafts
```

## Handoff

- **M4-02** reads the schema and the three `.jsonl` sets (test split for the report, dev split for prompt work) and the injection items
- **M5-01 / M5-03** cite the method from `packages/evals/gold/README.md` (synthetic, owner-labelled, second-model reviewed, kappa)
- Comment on the issue with the counts, kappa per set, the number of disagreements and the total spend
