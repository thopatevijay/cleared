# 0009. Deterministic AI workflows on OpenAI

- Status: accepted
- Date: 2026-10-28

## Context

The AI must judge evidence against scope with verifiable citations, explain holds, and draft dispute responses. Chats contain buyer-written text (an injection risk). Owner choice: OpenAI (2026-10-28).

## Decision

Four deterministic workflows (no open agent loop) behind an `AiProvider` adapter on the `openai` SDK with schema-enforced structured outputs: `extract` (small model; structured facts from text, images, PDFs), `check_scope` (larger model; pass 1 builds the claim list, pass 2 matches claims to quoted spans; code then verifies every quote appears verbatim in the stored evidence, and anything uncited becomes `unverifiable`), `explain_hold` (small model, grounded in a maintained, cited rule table), `draft_dispute` (larger model; reason-code mapping, ≤ 2000-character notes, evidence selection). Model IDs and prices are verified on the day (M0-07). A content-hash cache keyed on the input hash serves identical inputs.

## Alternatives considered

Anthropic with built-in Citations (strong option, owner chose OpenAI); an open tool-choosing agent loop (the paths are known); the PayPal agent toolkit for writes (accept-claim broken, no token refresh, no evidence tool).

## Consequences

The citation guarantee lives in our own verbatim check (deterministic, tested). Reversal cost: medium (adapter).

## Addendum 2026-10-29: Models (M0-07)

Verified on 2026-10-29 from https://developers.openai.com/api/docs/pricing and the model pages, and listed by
`GET /v1/models` for the `cleared` project key. Evidence: `docs/evidence/m0-07-openai-spike.md`.

| Role | `.env` | Model ID | USD / 1M input · cached · output | Used for |
|---|---|---|---|---|
| SMALL | `OPENAI_MODEL_SMALL` | `gpt-6-luna` | 0.10 · 0.01 · 0.50 | `extract` (reasoning effort `none`), `explain_hold` |
| LARGE | `OPENAI_MODEL_LARGE` | `gpt-6.1-terra` | 1.00 · 0.05 · 5.00 | `check_scope` passes 1 and 2 (effort `low`), `draft_dispute` |

- The gpt-6 family offers no dated snapshots, so the exact ID is what we pin. A model change goes through the evals
  (M4-02) before the ID changes. `gpt-5.4-mini-2026-03-17` is the dated fallback
- Surface: the **Responses API** on `openai` 7.45.1, with strict `json_schema` output built by `z.toJSONSchema`
  (optional properties are refused, because strict mode needs every property required) and re-validated with zod.
  PDFs are sent as `input_file`, images as `input_image`, and evidence goes in `<evidence>` blocks in the user
  message, never in `instructions`. Requests use `store: false`
- Transport: the SDK's `fetch` goes through the shared HTTP client (ADR 0011: 60 s, breaker, `onExchange`), with
  the SDK's own retries off. `POST /v1/responses` is not idempotent, so only a 429 is retried
- The verbatim check is `packages/core/src/proof/verbatim.ts`, and its normalisation is NFC plus whitespace
  collapse only
