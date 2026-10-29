# M0-03 · Local stack

Measured 2026-10-29 on the M0-03 branch: macOS (Apple silicon), Docker Engine 29.1.3, Docker Compose 2.40.3, Node 24.22.1, pnpm 12.15.0.

## Postgres major version (for M0-08)

| | Value | Source |
|---|---|---|
| Render default for a new Postgres | **18** | Render Blueprint spec, `postgresMajorVersion`: "If omitted, Render uses the most recent version supported by the platform (currently 18)." Render's upgrade guide: fully supported 13 to 18, 19 not yet supported. Read 2026-10-29 |
| Local compose image | `postgres:18.6-alpine` | `compose.yaml`; `select current_setting('server_version')` → `18.6` |

**M0-08 pins `postgresMajorVersion: "18"` in `render.yaml`.** Render cannot change it after creation.

The Postgres 18 image keeps its data in `/var/lib/postgresql/18/docker`, so the named volume `pgdata` mounts `/var/lib/postgresql` (not `/var/lib/postgresql/data`, as in images ≤ 17).

## Library versions

| Package | Version |
|---|---|
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 |
| pg / @types/pg | 8.23.1 / 8.23.1 |
| pg-boss | 12.38.0 |

## `make reset` wall time (budget ≤ 2 min)

`make reset` = `docker compose down -v` (drops the volume), `up -d --wait` (healthcheck `pg_isready`), Drizzle migrations, then the pg-boss schema.

| Run | Wall time |
|---|---|
| 1 (gate run, image already pulled) | 6.85 s |
| 2 | 6.48 s |
| 3 | 6.72 s |
| 4 | 6.74 s |

Median **≈ 6.7 s**, well inside 120 s. The first ever run also pulls the `postgres:18.6-alpine` image (network-bound, not measured here).

## Idempotency

- A second `make up` leaves the container running (`Container … Running`), re-runs the migrator (nothing pending) and the pg-boss start (schema current). `drizzle.__drizzle_migrations` stays at 1 row
- `PORT_OFFSET=100 make up` binds 5532: `psql …@localhost:5532/cleared` → `18.6|1`

## Gate results

- `select count(*) from drizzle.__drizzle_migrations` → `1`
- `select count(*) from information_schema.schemata where schema_name='pgboss'` → `1` (the `migrate` script installs it after the Drizzle migrations)
- `pnpm --filter @cleared/db test` with the stack up: 4 files, 7 tests passed (migrate ×2, transactional enqueue ×2, pg-boss round-trip ×2, package ×1)
- `pnpm check` with the stack up: green, the db integration tests run
- `make down && pnpm check`: green; `[@cleared/db] Postgres unreachable at localhost:5432: integration tests SKIPPED (start it with \`make up\`).`, 3 files and 6 tests skipped
