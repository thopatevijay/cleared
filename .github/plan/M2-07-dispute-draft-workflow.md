---
title: "M2-07 · Dispute draft workflow (reason-code mapping, ≤2000-char notes, evidence selection, compiled PDF <10 MB)"
milestone: "M2 · Dispute Loop"
labels: [agent, backend, critical]
blocked_by: [M2-04, M2-06]
estimate: "6h"
resources: [OPENAI]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-24, P-46]
---

## Context
This is where the proof pack pays off: the agent drafts the dispute response from pack facts only, and the seller approves it (storyboard 1:05–1:50). PayPal's limits are hard: notes ≤ 2000 characters, files jpg/gif/png/pdf < 10 MB each, ≤ 50 MB per call; one compiled PDF avoids all-or-nothing multi-file filing (B6 #15). Rubric: Technological Implementation, Potential Impact (disputes lost for lack of organised evidence).

## Scope
- **Reason-code mapping** (pure, `packages/core/src/disputes/reason-map.ts`), deciding `evidence_type` and which facts matter:
  - `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` → `PROOF_OF_FULFILLMENT` (delivery events, shipment/tracking facts)
  - `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` → `OTHER` (scope lines + `met` verdicts with citations, acceptance events)
  - when the re-fetched dispute lists evidence types PayPal requests (fields as recorded in the M0-05 fixtures), **PayPal's request wins** over the table
  - any other reason → `OTHER`, flagged `reason_unmapped` for the seller
- Workflow `draft_dispute@v1` on `OPENAI_MODEL_LARGE` via the M2-02 harness; input = dispute mirror (reason, amount, dates), extracted facts, and **only verified** scope citations; raw evidence text is never sent to this step
- Output schema: `notes` (string), `selected_evidence_item_ids`, `fact_refs` (which facts/citations each paragraph relies on)
- Output validators (code): `notes.length ≤ 2000` (Unicode code points; over-length → one repair, then fail, never truncated silently); selected ids ⊆ pack items; every `fact_ref` resolves; no URL, email or phone number that is not present in the pack
- **Compiled PDF** with `@cantoo/pdf-lib` (`packages/adapters/src/pdf/compile-evidence.ts`): cover page (dispute id, capture id, amount, reason, index of items with sha256 and dates), then each selected item (PDF pages embedded; images placed one per page; pasted text typeset in a fixed font with EN + Devanagari coverage); output **< 10 MB** checked after compile; over → typed error listing item sizes so the seller can deselect (no silent dropping)
- Persist in one transaction: compiled blob (BlobStore), `dispute_drafts` (notes, evidence_item_ids, evidence_type, compiled_blob_id, sha256 = `canonicalHash` of the filing payload), and `proposeAction` with kind from the dispute's current `allowed_actions` (`provide_evidence` preferred, else `provide_supporting_info`) and payload `{dispute_id, action, evidence_type, notes, compiled_blob_sha256, draft_id}`
- Triggers: `dispute.opened` / `dispute.status_changed` when an evidence action is allowed and the pack is `checked`; `pack.checked` for a pack whose dispute is open. Idempotent per (dispute id, pack check version, allowed action)
- Not drafted when `deadline_state = closed_for_action`; recorded as `too_late`

## Out of scope
- Approval and the PayPal call (M2-08); draft review UI and seller edits (M2-09)
- Accepting a claim (seller-only, M2-08 policy + M2-09 UI)

## Acceptance Criteria
- [ ] Reason-map unit table: not-received → `PROOF_OF_FULFILLMENT`; not-as-described → `OTHER`; a fixture with PayPal-requested evidence types overrides both; unknown reason → `OTHER` + `reason_unmapped`
- [ ] Replaying `fixtures/openai/draft-*` on the sample dispute (M0-05) + sample pack: notes ≤ 2000 chars, selected ids valid, a `dispute_drafts` row and a `proposed_actions` row whose `payload_sha256 == canonicalHash(payload)`
- [ ] A fixture returning 2,400 chars → repair → fail with `notes_too_long`; nothing stored
- [ ] A fixture inventing an evidence id or a URL absent from the pack fails validation
- [ ] The compiled PDF opens with pdf-lib, has 1 + selected-item page groups, its cover lists every item's sha256, and is < 10 MB; a selection totalling > 10 MB returns `pdf_too_large` with per-item sizes
- [ ] With allowed actions `provide_supporting_info` only, the proposal kind is `provide_supporting_info`; with `provide_evidence`, that kind
- [ ] Re-delivering the trigger creates no second draft; `closed_for_action` disputes produce `too_late`
- [ ] Live proof (claims OPENAI): one draft on the sample pack; notes ≤ 2000, latency < 60 s and cost recorded in `agent_runs`

## Deliverables
- `packages/core/src/disputes/{reason-map,draft,draft-schema}.ts`, `prompts/draft-dispute.v1.ts` + tests
- `packages/adapters/src/pdf/compile-evidence.ts` + test (fonts under `packages/adapters/assets/fonts/`, OFL-licensed)
- `apps/worker/src/jobs/draft-dispute.ts` + int test
- `packages/db/src/repositories/dispute-drafts.ts`

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/disputes
pnpm --filter ./packages/adapters exec vitest run src/pdf
pnpm --filter ./apps/worker exec vitest run src/jobs/draft-dispute
mkdir -p "$TMPDIR/m2-07" && PDF_OUT_DIR="$TMPDIR/m2-07" pnpm --filter ./packages/adapters exec vitest run src/pdf -t "sample pack" \
  && test "$(wc -c < "$TMPDIR/m2-07/sample-evidence.pdf")" -lt 10485760
pnpm --filter ./apps/worker exec vitest run src/jobs/draft-dispute.live.test.ts   # live, OPENAI budget; skipped without OPENAI_API_KEY
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-08 executes the proposal: it loads the compiled blob by `compiled_blob_id`, re-checks its sha256 and sends notes + PDF as multipart
- M2-09 shows the notes, the selected items, the PDF download and the payload hash being approved; a seller edit re-runs only validation + compile + `proposeAction` (new hash), not the model
- M2-10 relies on this firing automatically once the chargeback dispute reaches an evidence action
