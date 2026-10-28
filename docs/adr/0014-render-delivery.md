# 0014. Delivery on Render with a Blueprint, local compose, CI and MIT licence

- Status: accepted
- Date: 2026-10-28

## Context

Judges need a hosted demo kept up until 2026-12-15; the repo must be open source with a licence; the feedback-loop budgets must hold.

## Decision

A `render.yaml` Blueprint (web service, background worker, Postgres; region Oregon; starter plans) and a Deploy-to-Render button. docker compose for local Postgres (`make up` / `make down`) using the same migrations. One idempotent setup script (webhook registration, seed). GitHub Actions with a pnpm cache: lint, typecheck, unit, contract, fixture-replay integration, deterministic eval checks, gitleaks, dependency audit. Playwright end-to-end tests on the core flow. Node 24 LTS; pinned lockfile; MIT licence.

## Alternatives considered

Vercel (serverless doesn't fit the long-running worker); Terraform (three resources); a free tier (spins down; Postgres expiry).

## Consequences

≈ $20/month through judging. Reversal cost: low.
