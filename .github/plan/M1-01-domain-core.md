---
title: "M1-01 · Domain core: entities, invariants, state machines + unit tests"
milestone: "M1 · Walking Skeleton"
labels: [backend, critical]
blocked_by: [M0-GATE]
estimate: "5h"
resources: []
needs: []
---

## Context
Every later ticket (ingest, holds, disputes, governance, AI) leans on one pure domain model. The rubric's **Technological Implementation** depends on states that mirror PayPal exactly and on invariants that can't be bypassed (approval bound to a hash, deadline refusal, single owner workspace). Putting these in `packages/core` with no I/O (ADR 0001) makes them fast to test and impossible to skip from an adapter.

## Scope
- `packages/core` package (TS 6.0.3, ESM, `exports` map); imports nothing from frameworks, SDKs, `pg`, `node:fs`/`net`/`http` (the landing check enforces this)
- **Value types:** branded IDs (`WorkspaceId`, `CaptureId`, `OrderId`, `DisputeId`, `ActionId`); `Money` as a decimal string + ISO currency, with a minor-unit exponent table (JPY 0, INR/USD 2, …) and lossless parse/format helpers (no floats); `Instant` as an ISO UTC string
- **Entities + invariants** for each module in `docs/architecture.md` §2: Workspace (`seller | demo`, expiry constant 2026-12-16T00:00Z for demo), Payment, ProofPack, EvidenceItem, Hold, Dispute, ProposedAction, Approval, AuditEntry
- **PayPal mirror mapping:** a capture's `status` and `status_details.reason` map to the Payment state with no invented states. Unknown PayPal values are kept verbatim as `{ kind: "unrecognised", raw }`, never coerced. `isHold(capture)` = `status === "PENDING"` with a reason
- **State machines** (`docs/architecture.md` §2) as transition tables plus `transition(state, event) → Result<next, DomainError>`: ProofPack, Hold, our Dispute draft states, and ProposedAction including `executing → unknown → succeeded | failed`. Payment and PayPal-side Dispute are mirror-only: `applyMirror(prev, next, updateTime)` rejects older `update_time` (event order is never trusted)
- **Policy functions (pure):**
  - `canExecute(action, { now, dueDate, hasActionLink, approval, payloadSha256, killSwitch })` returns allow or a refusal reason. It refuses after `seller_response_due_date − 1 h`, without the HATEOAS link, on a hash mismatch, or while the kill switch is on
  - `canonicalJson(value)` (sorted keys) as the hash input. Hashing happens in adapters
- **Ownership rule:** `resolveOwner({ customId, ownerRow })` returns `owned(ws) | mismatch | unowned`
- **Events:** a discriminated union of every event in §2 (`payment.captured` … `action.unknown`), each with `version: 1`, plus zod 4 schemas
- **Contracts:** the zod error envelope `{error:{code,message,details,correlationId}}` (ADR 0003) and a `Result<T,E>` helper
- `packages/core/src/index.ts` re-exports the public API (hot file: this ticket creates it)

## Out of scope
- Persistence and repositories → M1-02
- The hold rule table, release estimates and explanations → M3-01 / M3-02
- Executing actions or reconciling → M2-08
- HTTP contracts for specific routes → defined by the tickets that add those routes

## Acceptance Criteria
- [ ] `pnpm --filter @cleared/core test` passes. Every transition table is enumerated exhaustively (each allowed and each forbidden pair has a case)
- [ ] Coverage for `packages/core/src` ≥ 90% lines and branches (`vitest --coverage`, threshold in the config)
- [ ] The capture mapping test runs against every capture body in `fixtures/paypal/orders/` and `fixtures/paypal/disputes/` (M0-04/M0-05) and maps each with no `unrecognised` result for the statuses seen there
- [ ] `applyMirror` rejects an older `update_time` and accepts an equal or newer one (tests)
- [ ] `canExecute` refuses at `due − 1 h` exactly and at `due − 59 min`, allows at `due − 61 min`, and refuses with no link, a mismatched hash or the kill switch on (tests)
- [ ] `Money` round-trips `"120.00" USD`, `"1000" JPY`, `"0.10" INR` with no float arithmetic (grep finds no `parseFloat`/`Number(` in `money.ts`)
- [ ] `./scripts/landing-checks.sh --fast` passes (including the no-I/O import check on `packages/core/src`)

## Deliverables
- `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts`
- `packages/core/src/{index.ts,ids.ts,money.ts,time.ts,result.ts,errors.ts,events.ts,contracts/error-envelope.ts}`
- `packages/core/src/{accounts,payments,proof,holds,disputes,actions}/*.ts` (entities, machines, policy)
- `packages/core/test/**/*.test.ts`

## Validation Gate
```bash
pnpm install --frozen-lockfile
pnpm --filter @cleared/core typecheck
pnpm --filter @cleared/core test -- --coverage 2>&1 | tee "$TMPDIR/m1-01-test.log"
! grep -rnE "from ['\"](next|react|pg|pg-boss|drizzle-orm|openai|@paypal/|resend|@sentry/|pino|node:fs|node:net|node:http)['\"/]" packages/core/src
! grep -nE "parseFloat|Number\(" packages/core/src/money.ts
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-02** maps entities to tables and reuses the enums (payment status, pack state, action state, evidence kind, verdict).
- **M1-03** uses the `events.ts` union and schemas as outbox payloads.
- **M1-04** uses the capture mapping, `applyMirror` and `resolveOwner`.
- **M2-08** uses `canExecute` and `canonicalJson`. **M3-01** extends `isHold`.
