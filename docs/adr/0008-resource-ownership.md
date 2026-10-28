# 0008. Ownership of PayPal resources per workspace

- Status: accepted
- Date: 2026-10-28

## Context

All demo workspaces share one sandbox merchant and one app-scoped webhook, so the poll and the webhooks return every workspace's resources. Dispute replies are one-shot, so a cross-workspace mix-up is unrecoverable.

## Decision

Every order Cleared creates carries `custom_id = workspace_id`. Table `paypal_resource_owner(resource_type, resource_id) → workspace_id` is written when the resource is created; child resources (captures, disputes) inherit their owner on ingest. Ingest quarantines anything without an owner. Every action re-checks ownership before execution.

## Alternatives considered

Separate sandbox merchants per workspace (manual account creation; not scalable); trusting the client-side workspace ID.

## Consequences

A small table and a check on every ingest and action. Reversal cost: low.
