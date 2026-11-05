# Gold sets (M4-01)

Labelled ground truth for Cleared's three AI steps: evidence **extraction** (30 items), **scope**
checking (40) and **hold** explanations (20: 10 EN/HI pairs). The README, video and Devpost numbers are
measured against these sets by the M4-02 eval runner. **All personal data is synthetic**
(data policy): people, businesses, chats, invoices and ids are invented; emails use
`@example.test`, phones `+CC-00000-NNNNN`, PayPal ids `SYNTH-…`. Hold items quote PayPal's published
rule text verbatim from the rule table (`packages/core/src/holds/rules.ts`, M3-01).

## Format (ContractNLI-style)

Schema: `packages/evals/src/gold/schema.ts` (`GoldItemSchema`, exported as `@cleared/evals/gold/schema`).

- An item has `id`, `set`, `split` (`dev` | `test`), `locale` (`en` | `hi`), a synthetic `persona`
  (country, trade, goods/services, currency), `tags` (`hinglish`), `injection`, `documents[]`
  (`doc_id`, `kind`, `title`, `text`) and `hypotheses[]`.
- A hypothesis is labelled `met` | `partial` | `missing` | `unverifiable` with `spans[]`
  (`doc_id`, `start`, `end`, `quote`, where `quote === text.slice(start, end)`). `unverifiable` has no
  spans; `met` and `partial` have at least one. One scheme for all three sets:
  - **extraction**: a fact (`field` = amount, deliverable, date, party, tracking_number, carrier; `value`)
  - **scope**: a scope line the seller agreed to deliver, judged against the delivery evidence
  - **holds**: a fact a correct explanation must contain (`fact_code`, shared by the EN and HI item of a
    pair), plus one tempting claim the sources do not support (code `not_…`)
- `documents[].kind` is an `evidence_items.kind` value; the holds set adds `paypal_capture` (the capture:
  `status: PENDING` + `status_details.reason`) and `paypal_rule` (the rule row's verbatim source quote).
- Holds items carry `hold`: `pair_id`, `capture_reason`, `sample` (a badged sample scenario),
  `expected_rule_id` (the M3-01 rule row) and `forbidden_claims` as codes: `guaranteed_release`,
  `seller_won`, `exact_release_date`.
- `injection: true` (6 scope items): the buyer chat contains an instruction aimed at an AI reviewer.
  The labels are what they would be without that line. M4-02 reuses these items.
- `intended_label` is the generator's target. It is never shown to the labeller (Claude or the owner) or the reviewer, and it is
  not ground truth.

## Spread

| set | items | dev / test | hypotheses | countries | currencies | Hinglish | injection |
|---|---|---|---|---|---|---|---|
| extraction | 30 | 8 / 22 | 165 | IN, KE, NG, ID, PH × 6 | USD 8, EUR 8, INR 8, JPY 6 | 3 | 0 |
| scope | 40 | 9 / 31 | 160 | × 8 each | 10 each | 4 | 6 |
| holds | 20 | 4 / 16 (2 pairs dev) | 80 | × 4 each | USD 8, EUR/INR/JPY 4 | 5 | 0 |

Goods and services alternate. Hold scenarios: `PENDING_REVIEW` ×2 (`payment_review`), `BUYER_COMPLAINT`
×2 (`dispute_hold`), `goods_delivered`, `service_completed`, `reason_OTHER`, and the badged samples
`new_seller_21d`, `reserve`, `limitation` (capture reason `OTHER`, `sample: true`).

**Split:** `dev` when `sha256("cleared-gold-v4:" + key)`'s first 4 bytes / 2³² < 0.25 (`plan.ts`
`splitFor`); the key is the item id, or the pair id for holds, so both languages of a pair share a split.
`dev` is for prompt work; only `test` is reported.

## Method

1. **Plan.** `src/gold/plan.ts` fixes the 90 slots before any model writes a word: set, persona,
   document kinds, a target label per hypothesis, injection items and hold scenarios. The spread above
   holds by construction.
2. **Draft** (`pnpm eval:draft`). `OPENAI_MODEL_LARGE` (`gpt-6.1-terra`, reasoning effort `none`) writes
   the documents and hypotheses for each slot (80 calls; one per hold pair). The prompts and the model id
   are stored with the data in `drafts/generator.json`; prompt version `gold-draft@v1`. Each exchange is
   recorded (scrubbed) under `fixtures/openai/gold/draft/`, and the drafts are built from those
   recordings, so `pnpm eval:draft --replay` gives byte-identical output with no spend.
3. **Second-model review** (`pnpm eval:review`). A model that differs from the production model for
   the task labels every item independently, with verbatim quotes turned into checked spans
   (`reviews/<set>.jsonl`; recordings under `fixtures/openai/gold/review/`; prompt `gold-review@v1`):

   | set | production model (workflow under test) | reviewer |
   |---|---|---|
   | extraction | `gpt-6-luna` (SMALL, `extract`) | `gpt-6.1-terra` (LARGE) |
   | scope | `gpt-6.1-terra` (LARGE, `check_scope`) | `gpt-5.4-mini-2026-03-17` |
   | holds | `gpt-6-luna` (SMALL, `explain_hold`) | `gpt-6.1-terra` (LARGE) |

   **Who labels what** (owner decisions 2026-11-03 and 2026-11-04, #45): **Claude**
   (`claude-opus-5-5`, Anthropic: a different vendor from every model under test and every reviewer,
   all OpenAI) labels the 69 `test` items (22 extraction, 31 scope, 16 holds), which are the only items
   M4-02 reports, plus `scope-028` from `dev` (step 4), marked `labelled_by: "claude:claude-opus-5-5"`.
   One item, `ext-004`, was labelled by the owner before that decision and stays `labelled_by: "owner"`.
   The other 20 `dev` items (8 / 8 / 4) are used only for prompt work and never reported. They take the
   second-model review's labels and spans verbatim and are marked `labelled_by: "model:<reviewer model
   id>"`. No labeller id may be the task's production model.
4. **Dev items from the review** (`pnpm eval:adopt-dev`). A deterministic step with no API call and
   no spend. It copies each `dev` item's review into `gold/<set>.jsonl` after checking every span
   (verbatim at its offsets, at least one for `met`/`partial`, none for `unverifiable`). A `dev` item
   whose review fails any check is refused: nothing is written for it, no rule is relaxed, and it joins
   the labelling queue. One item is refused: **`scope-028`**. Its reviewer labelled H2 `met`, but the
   only quote skips a line of the handover, so it isn't verbatim and no span is left. Re-running the
   step writes the same bytes and keeps every primary label (`owner` or `claude:<id>`).
5. **Claude labels** (`pnpm eval:label`; `--split test` is the default and the only choice). Claude
   labelled each queued item (the `test` items plus `scope-028`) **independently**: it read only the
   item's documents and hypotheses, printed one item at a time with the target label stripped, and did
   not see the reviews, the target labels or the generator prompts until every label was written and
   committed. Each hypothesis got a label, verbatim quotes and a one-line rationale (`note`). The labels
   go through the same writer as the terminal flow (`eval:label --from <answers> --by
   claude:claude-opus-5-5`): each quote names its document, offsets are computed at its first
   occurrence there, and `met`/`partial` without a quote or `unverifiable` with one is refused. The
   scope items with an "AI reviewer" instruction were labelled as if that line were absent; holds facts
   were judged against the capture and PayPal's rule text only.
6. **Reconcile** (`pnpm eval:label --reconcile`, same `--from`/`--by`). Each review is embedded in its
   item. Only then were the reviews read: for every disagreement on a `test` item, Claude re-read the
   documents and recorded the final label (its own or the reviewer's) with a one-line reason in
   `disagreements.jsonl` (`decided_by: "claude:claude-opus-5-5"`). A label was flipped only when the
   documents supported the reviewer, never to raise agreement. Agreement is Cohen's kappa per set:
   the labeller's first label against the reviewer's, over the `test` hypotheses only.
7. **Owner spot-check** (`spotcheck.md`): not performed (owner decision 2026-11-04, #45). The file
   stays so the check can still be done later; no claim relies on it.
8. **Validate** (`pnpm eval:validate`): schema, counts (30/40/20), ≥ 8 scope items per label, ≥ 5
   injection items, 10 EN/10 HI with matching fact codes and known rule rows, every span verbatim, the
   seeded split, `owner` or `claude:<id>` on every `test` item and `model:<its reviewer>` (matching its
   review exactly) or a primary label on every `dev` item, no labeller equal to the production model, a
   non-production review on every item, one decided row (`decided_by`) per `test` disagreement, kappa
   over `test`, and the spend ledger (each UTC day ≤ $1). `--pii` scans drafts, reviews and gold sets
   for real-looking emails, phone numbers and PayPal ids.

## Results

From `pnpm eval:validate` (labeller's first label vs the second model, `test` split only):

| set | kappa | agreement | n (hypotheses) | disagreements | kept / flipped to reviewer |
|---|---|---|---|---|---|
| extraction | 0.843 | 96.7% | 120 (22 items) | 4 | 4 / 0 |
| scope | 0.834 | 88.7% | 124 (31 items) | 14 | 12 / 2 |
| holds | 0.626 | 84.4% | 64 (16 items) | 10 | 10 / 0 |

Extraction includes `ext-004` (owner-labelled, 5 hypotheses, no disagreement). All 10 holds
disagreements are the same pattern: a "guaranteed release" claim Claude labelled `missing` (the
sources contradict it: an open fraud review, a hold "to cover possible chargeback", "approximately
24 hours") and the reviewer labelled `unverifiable`; both mean the claim is unsupported. The two flips
(`scope-031/H3`, `scope-040/H4`) went from `unverifiable` to `partial`: a form and a certificate file were
delivered, but whether they do what the line promised is unknown.

**Claims wording** (M4-02, README, video, Devpost): "gold set labelled by Claude (independent of the
OpenAI models under test), cross-checked by a second model (kappa = …)". Never say "owner-labelled" or "human-labelled". The disagreements were settled by Claude itself (26 kept, 2 flipped), so the kappa measures Claude vs the reviewer, not accuracy against a human.

Before labelling, the reviewer agreed with the generator's *target* label on 156/165 extraction,
137/160 scope and 76/80 hold hypotheses. That is a sanity check on the drafts, not an accuracy claim.

Spend: `SPEND.md` (M4-01 total $0.4685 on 2026-11-03).
