# 0015. Email for deadline alerts and sign-in

- Status: accepted
- Date: 2026-10-28

## Context

Dispute deadlines are fatal and in-app nudges can't reach an absent seller; magic links need an email sender.

## Decision

Resend for magic links and alerts (new hold, new dispute, deadline at T-72 h and T-24 h), plus an in-app notification centre. Sending is limited to verified recipients until a domain is verified (owner decision in M0-00).

## Alternatives considered

In-app only (misses deadlines); WhatsApp/SMS (provider approval lead time; a later channel).

## Consequences

One more vendor key. Reversal cost: low.
