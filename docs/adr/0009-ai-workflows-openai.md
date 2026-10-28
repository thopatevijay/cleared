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
