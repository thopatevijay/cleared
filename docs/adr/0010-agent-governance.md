# 0010. Agent governance: propose, approve, then execute

- Status: accepted
- Date: 2026-10-28

## Context

The agent's outputs file disputes and change seller state at PayPal; submissions are effectively one-shot; deadlines are fatal.

## Decision

The agent can only insert `proposed_actions`. Execution requires a seller approval bound to the payload sha256. Before execution: policy check (in code; `accept_claim` needs typed confirmation and is never automatic), workspace ownership, a fresh re-fetch of the dispute requiring the matching HATEOAS link, and refusal when `now > seller_response_due_date − 1 h`. Execution states include `unknown` (timeout after send), resolved by reconciling against PayPal. Kill switch: a DB flag plus an env flag stop all executions. Append-only `audit_log` for every step. Limits: ≤ 6 model calls per run, token caps, $0.10 per demo workspace, $1/day global.

## Alternatives considered

Auto-filing (unsafe, contradicts "you hold the keys"); a policy engine such as OPA (few policies, all in code).

## Consequences

Every write has a human in the loop and an audit trail. Reversal cost: medium.
