# 0013. Observability baseline

- Status: accepted
- Date: 2026-10-28

## Context

The core flow has SLOs (webhook → hold visible, approved action → PayPal 2xx, zero missed deadlines) and runs unattended through judging.

## Decision

pino JSON logs with a correlation ID through request → job → PayPal `debug_id`; agent runs and steps in the database (tokens, cost, latency); Sentry (free tier) for errors; SLO checks and a daily synthetic run of the judge path inside the reconcile job, raising Sentry alerts; `/healthz` and `/readyz`.

## Alternatives considered

An OpenTelemetry collector and backend (heavy for two services; trigger: a third service).

## Consequences

Enough to run the judging window unattended. Reversal cost: low.
