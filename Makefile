# Local stack lifecycle (M0-03). Every target is idempotent; every gate starts with `make reset`.
# PORT_OFFSET shifts the host port of Postgres (parallel worktrees); the default keeps 5432.
PORT_OFFSET ?= 0
PG_PORT := $(shell echo $$((5432 + $(PORT_OFFSET))))
DATABASE_URL ?= postgres://cleared:cleared@localhost:$(PG_PORT)/cleared
export PG_PORT DATABASE_URL

COMPOSE := docker compose -f compose.yaml

.PHONY: up down reset migrate psql

## up: start Postgres, wait until healthy, apply migrations (a second run changes nothing)
up:
	$(COMPOSE) up -d --wait postgres
	$(MAKE) --no-print-directory migrate

## down: stop the stack, keep the data volume
down:
	$(COMPOSE) down

## reset: drop the data volume, then up (fresh database, migrations applied)
reset:
	$(COMPOSE) down -v --remove-orphans
	$(MAKE) --no-print-directory up

## migrate: apply pending Drizzle migrations (forward-only)
migrate:
	pnpm --filter @cleared/db run migrate

## psql: open a psql shell on the local database
psql:
	psql "$(DATABASE_URL)"
