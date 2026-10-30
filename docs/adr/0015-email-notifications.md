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

## Addendum 2026-10-30 (M1-05): Resend through our own client, not the SDK

**Decision: our own Resend client** (`packages/adapters/src/email/resend.ts`), a `POST
https://api.resend.com/emails` on the shared `createHttpClient` (vendor `resend`, 10 s timeout), behind
the `EmailSender` interface. The `resend` npm SDK is not installed.

**Reason.** The test was the same as the ADR 0011 addendum for PayPal: use the SDK only if its transport
can go through the one shared client. Reading `resend@6.35.0` (`dist/index.mjs`, `Resend.fetchRequest`),
every call goes to the global `fetch` with no option to inject a transport or a timeout. An SDK send would
bypass the client's timeout, retry rules, breaker, correlation id and the `onExchange` hook the fixture
recorder uses (`fixtures/resend/send-email.json` is recorded through it).

**Recipient guard.** `withRecipientGuard` wraps any `EmailSender`. When `EMAIL_RECIPIENT_ALLOWLIST` is set
(every environment through the hackathon), a recipient outside it gets no request at all; the refusal is
logged with a reason, and the caller's HTTP response does not change (no account enumeration).

**Retries.** A send carries Resend's `Idempotency-Key` header (the magic link id), so the shared client
may retry it on timeout or 5xx without sending twice.

**Consequences.** One HTTP path for every vendor. We own the request and response typing for one endpoint
(zod at the boundary). Reversal cost: low.
