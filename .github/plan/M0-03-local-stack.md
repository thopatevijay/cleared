---
title: "M0-03 · Local stack: compose Postgres, make up/down, Drizzle baseline, pg-boss"
milestone: "M0 · Recon & Bootstrap"
labels: ["infra", "backend"]
blocked_by: ["M0-02"]
estimate: "3h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14]
---

## Context

Postgres is the system of record for state, outbox, pg-boss jobs and evidence blobs (ADR 0002,
ADR 0004). Every gate runs from a clean stack (`make up`, migrations, seed), and the environment
reset budget is ≤ 2 min. The core architecture rule, "a state change and its job in one
transaction", must be proven possible with pg-boss before M1-03 builds on it. Reliability under
judging (Technological Implementation) starts here.

## Scope

- `compose.yaml`: one Postgres service, the **same major version** Render offers for its starter
  Postgres today (check the Render docs; record the version so M0-08 pins the same
  `postgresMajorVersion`), credentials matching `DATABASE_URL` in `.env.example`, a named volume,
  a healthcheck (`pg_isready`)
- `Makefile`: `make up` (start + wait healthy + migrate), `make down`, `make reset` (drop the
  volume, up, migrate), `make migrate`, `make psql`. Each target is idempotent
- `packages/db`: `drizzle.config.ts` (reads `DATABASE_URL`), a `migrate` script using
  drizzle-orm's migrator (forward-only, run on deploy later), a baseline migration that only
  enables what later tables need (e.g. `pgcrypto`) and creates nothing domain-specific, a typed
  `createDb(url)` with a pool (max 10, ADR 0002/decision 6)
- pg-boss 12: a `createQueue(db)` helper in `packages/db` (or `apps/worker`) that starts pg-boss
  on the same database (its own schema), and a smoke test proving **transactional enqueue**: a job
  sent through pg-boss's `db` option inside a transaction exists after COMMIT and does **not** exist
  after ROLLBACK
- Integration tests run against the compose Postgres (skipped with a clear message when
  `DATABASE_URL` is unreachable, so `pnpm check` stays green without Docker)
- Measure `make reset` wall time

## Out of scope

- Domain tables, workspace-scoped repositories, the outbox table (M1-02)
- Outbox relay, consumers, backoff/DLQ, correlation ids (M1-03)
- Seed data and `scripts/setup.ts` (M1-02 / M1-04)
- Render Postgres (M0-08)

## Acceptance Criteria

- [ ] `make up` from nothing starts Postgres, waits for healthy and applies migrations; a second `make up` is a no-op
- [ ] `make reset` completes in ≤ 2 min (measured, recorded)
- [ ] `pnpm --filter @cleared/db run migrate` applies the baseline; `__drizzle_migrations` has one row
- [ ] The transactional-enqueue test passes: job present after COMMIT, absent after ROLLBACK
- [ ] pg-boss creates its schema and a job round-trips (send → work → completed) in a test
- [ ] `pnpm check` passes with Docker stopped (integration tests skip with a message) and with it running (they run)
- [ ] The Postgres major version is recorded in `docs/evidence/m0-03-local-stack.md` for M0-08

## Deliverables

- `compose.yaml`, `Makefile`
- `packages/db/drizzle.config.ts`, `packages/db/src/{client,migrate,queue}.ts`, `packages/db/migrations/0000_*.sql`
- `packages/db/test/{migrate,transactional-enqueue,pgboss-roundtrip}.test.ts`
- `docs/evidence/m0-03-local-stack.md` (versions, reset time)

## Validation Gate

```bash
docker info >/dev/null && echo "docker ok"
time make reset                                                    # drops the volume, up, migrate; expect <= 120 s
make up                                                            # idempotent second run
psql "postgres://cleared:cleared@localhost:5432/cleared" -tAc "select count(*) from drizzle.__drizzle_migrations"   # expect 1
psql "postgres://cleared:cleared@localhost:5432/cleared" -tAc "select count(*) from information_schema.schemata where schema_name='pgboss'"   # expect 1
pnpm --filter @cleared/db test
make down && pnpm check                                            # integration tests skip, still green
```

## Handoff

- **M1-02:** adds domain tables as Drizzle migrations on top of the baseline; uses `createDb`
- **M1-03:** builds the outbox and consumers on the proven transactional enqueue
- **M0-08:** pins the recorded Postgres major version in `render.yaml`
- **Every gate:** starts with `make reset`
