# 0006. Seller connection: the platform sandbox app now, the partner model later

- Status: accepted
- Date: 2026-10-28

## Context

Acting on a third party's PayPal account in production requires PayPal's partner model (THIRD_PARTY referrals + PayPal-Auth-Assertion; dispute and transaction-search permissions; no tracking permission) and PayPal's approval. Judges have no PayPal accounts.

## Decision

For the hackathon, the platform's own sandbox REST app (credentials in the platform environment) is the connected merchant; every workspace's resources are separated by ADR 0008. All PayPal calls go through a `SellerConnection` interface, so the partner model later adds the Auth-Assertion header without touching callers. Sellers never paste REST secrets.

## Alternatives considered

Sellers pasting their own client ID and secret (full-power secrets, high friction, one webhook ID per connection); Log in with PayPal (identity only).

## Consequences

The demo can't connect arbitrary real sellers; this is documented as the production path. Reversal cost: medium.
