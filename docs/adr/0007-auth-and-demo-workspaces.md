# 0007. Email magic links for sellers; anonymous demo workspaces for judges

- Status: accepted
- Date: 2026-10-28

## Context

Judges need instant access with no keys; sellers need authentication without stored passwords.

## Decision

Sellers sign in with single-use email magic links (Resend; 15-minute expiry; token hash stored). "Try as demo seller" creates an anonymous demo workspace with an httpOnly secure session cookie. Limits: 3 workspaces per IP per day, 200 globally, an LLM budget of $0.10 each. Demo workspaces last until 2026-12-16 and are purged on 2026-12-22. Authorization is enforced server-side in the repository layer (every query scoped by `workspace_id`).

## Alternatives considered

Email/password (storing passwords); Log in with PayPal (needs PayPal accounts judges lack); no auth (cross-workspace exposure).

## Consequences

Needs an email provider (also used by ADR 0015). Reversal cost: medium.
