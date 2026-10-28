# 0002. Postgres as the system of record, including evidence blobs

- Status: accepted
- Date: 2026-10-28

## Context

Money, actions and approvals need strong consistency. Launch data is < 1 GB; evidence files are ≤ 10 MB each (PayPal's evidence limit).

## Decision

Render managed Postgres (starter, Oregon) for all entities, the outbox and the pg-boss jobs. Evidence bytes go in a `blobs` table (bytea) behind a `BlobStore` interface. Drizzle (SQL-first) migrations, forward-only, run on deploy. Daily backups. sha256 per blob.

## Alternatives considered

S3/R2 now (an extra service and key for < 1 GB); Prisma (the latest line is a release candidate; Drizzle stays close to SQL); free Postgres (expires after 30 days, inside judging).

## Consequences

One store to operate; transactions span state, outbox and jobs. Trigger to move blobs to S3: > 5 GB or > 50 real sellers. Reversal cost: low (adapter swap).
