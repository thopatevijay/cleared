# Gold-set spend (M4-01)

One row per live run and model, from the API responses' `usage` (tokens × `packages/adapters/src/ai/pricing.ts`).
Replay runs spend nothing. Each UTC day must stay ≤ $1.00 (`LLM_DAILY_CAP_USD`, docs/adr/0010-agent-governance.md).

| date (UTC) | command | model | calls | input tokens | cached | output tokens | reasoning | USD |
|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | eval:draft | gpt-6.1-terra | 3 | 2045 | 0 | 1459 | 0 | 0.0093 |
| 2026-11-03 | eval:draft | gpt-6.1-terra | 80 | 60015 | 0 | 46418 | 0 | 0.2921 |
| 2026-11-03 | eval:review | gpt-6.1-terra | 2 | 1916 | 0 | 407 | 0 | 0.0040 |
| 2026-11-03 | eval:review | gpt-5.4-mini-2026-03-17 | 1 | 1012 | 0 | 285 | 0 | 0.0020 |
| 2026-11-03 | eval:review | gpt-6.1-terra | 48 | 46324 | 0 | 8893 | 0 | 0.0908 |
| 2026-11-03 | eval:review | gpt-5.4-mini-2026-03-17 | 39 | 38680 | 0 | 9180 | 0 | 0.0703 |
