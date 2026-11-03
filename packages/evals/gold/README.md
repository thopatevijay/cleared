# Gold sets (M4-01)

Labelled ground truth for Cleared's three AI steps: evidence **extraction** (30 items), **scope**
checking (40) and **hold** explanations (20: 10 EN/HI pairs). The README, video and Devpost numbers are
measured against these sets by the M4-02 eval runner. **All personal data is synthetic**
(PROJECT.md §9.1): people, businesses, chats, invoices and ids are invented; emails use
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
- `intended_label` is the generator's target. It is never shown to the owner or the reviewer, and it is
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
3. **Owner labels** (`pnpm eval:label`, P-53). A terminal tool shows each item's documents and hypotheses
   and records the label, the spans (typed as a quote; offsets computed, ambiguity resolved by choice)
   and a note into `gold/<set>.jsonl`. The target label and the model's review are hidden.
4. **Second-model review** (`pnpm eval:review`). A model that differs from the production model for
   the task labels every item independently, with verbatim quotes turned into checked spans
   (`reviews/<set>.jsonl`; recordings under `fixtures/openai/gold/review/`; prompt `gold-review@v1`):

   | set | production model (workflow under test) | reviewer |
   |---|---|---|
   | extraction | `gpt-6-luna` (SMALL, `extract`) | `gpt-6.1-terra` (LARGE) |
   | scope | `gpt-6.1-terra` (LARGE, `check_scope`) | `gpt-5.4-mini-2026-03-17` |
   | holds | `gpt-6-luna` (SMALL, `explain_hold`) | `gpt-6.1-terra` (LARGE) |

5. **Reconcile** (`pnpm eval:label --reconcile`). Each review is embedded in its item; for every
   disagreement the owner sees both labels and records the final one with a reason in
   `disagreements.jsonl`. Agreement is Cohen's kappa per set: the owner's first label against the
   reviewer's, over all hypotheses.
6. **Validate** (`pnpm eval:validate`): schema, counts (30/40/20), ≥ 8 scope items per label, ≥ 5
   injection items, 10 EN/10 HI with matching fact codes and known rule rows, every span verbatim, the
   seeded split, owner label + non-production review on every item, one decided row per disagreement,
   kappa, and the spend ledger (each UTC day ≤ $1). `--pii` scans drafts, reviews and gold sets for
   real-looking emails, phone numbers and PayPal ids.

## Results

| set | kappa (owner vs reviewer) | agreement | disagreements |
|---|---|---|---|
| extraction | after P-53 | | |
| scope | after P-53 | | |
| holds | after P-53 | | |

Before the owner labels, the reviewer agreed with the generator's *target* label on 156/165 extraction,
137/160 scope and 76/80 hold hypotheses. That is a sanity check on the drafts, not an accuracy claim.

Spend: `SPEND.md` (M4-01 total $0.4685 on 2026-11-03).
