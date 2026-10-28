---
title: "M2-03 · Extraction workflow (small model, structured)"
milestone: "M2 · Dispute Loop"
labels: [agent, backend]
blocked_by: [M2-01, M2-02]
estimate: "4h"
resources: [OPENAI]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-24, P-46]
---

## Context
The `extract` workflow (ADR 0009) turns chats, receipts and PDFs into structured facts that the scope check and the dispute draft reason over. Facts are the "pack shows facts" fallback when the larger model is down (architecture §9). Rubric: Technological Implementation, Innovation (proof built at payment time). Target: extraction ≥ 90% on the gold set (measured in M4-02).

## Scope
- Workflow `extract@v1` in `packages/core/src/proof/extract.ts` run through the M2-02 harness on `OPENAI_MODEL_SMALL`
- Input per evidence item: `evidence_items.text` for text/PDF-with-text; image and image-only PDF bytes as image/PDF input parts; always inside the harness data blocks with the item id and sha256
- Output zod schema (versioned `facts@v1`):
  - `parties` (role: seller | buyer | other, display name as written)
  - `amounts` (value as decimal string, ISO currency)
  - `dates` (ISO 8601, with what the date refers to)
  - `deliverables` (what was promised or delivered, with `kind: promised | delivered`)
  - `delivery_events` (sent / opened / accepted, kept as **separate** facts: prior-art lesson)
  - `shipment` (carrier, tracking number) when present
  - each fact carries `source_quote` (≤ 300 chars) and `evidence_item_id`
- Output validator: every `evidence_item_id` must be one of the input items; amounts/currencies parse; dates parse
- Worker consumer on `evidence.added` (idempotent on `evidence_item_id` + prompt version): runs extraction, inserts `extracted_facts` (facts jsonb, model, run_id) and enqueues the scope check (`pack.extracted` job for M2-04) in one transaction. Runs once per item; the content-hash cache covers identical canned evidence
- Degraded / budget-exceeded runs leave the item without facts and record why; the pack stays `collecting`

## Out of scope
- Verbatim verification of quotes and verdicts (M2-04; extraction quotes are hints, not citations)
- UI (M2-05); gold set and accuracy numbers (M4-01, M4-02)

## Acceptance Criteria
- [ ] Replaying the M0-07 extraction fixtures (`fixtures/openai/extract-*`) on the synthetic sample evidence yields schema-valid facts with the expected parties, amounts and delivery events (assertions per fixture)
- [ ] Sent, opened and accepted delivery events come out as three separate facts on the sample chat that contains all three
- [ ] A fact pointing at an evidence id not in the input fails the validator → repair attempt → `failed_output`; nothing is written
- [ ] Re-delivering the same `evidence.added` job writes no second `extracted_facts` row
- [ ] An image-only receipt (synthetic) is sent as an image part, and facts come back with that item's id
- [ ] Budget exceeded or degraded → no facts row, run status recorded, pack unchanged
- [ ] Live proof (claims OPENAI): one run on the synthetic sample pack matches the fixture's fact set (same parties, amounts and event kinds)

## Deliverables
- `packages/core/src/proof/extract.ts`, `facts-schema.ts`, `prompts/extract.v1.ts` + tests
- `apps/worker/src/jobs/extract-evidence.ts` + `extract-evidence.int.test.ts`
- `packages/db/src/repositories/extracted-facts.ts`

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/proof/extract
pnpm --filter ./apps/worker exec vitest run src/jobs/extract-evidence
pnpm --filter ./apps/worker exec vitest run src/jobs/extract-evidence.live.test.ts   # live, OPENAI budget; skipped without OPENAI_API_KEY
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-04 reads `extracted_facts` for pass 1 claim building and runs on the `pack.extracted` job
- M2-05 shows facts (also the degraded fallback); M2-07 draws dates, amounts and delivery events from facts
- M4-01/M4-02 score this workflow on the 30-case extraction gold set
