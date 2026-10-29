-- M0-03 baseline: enables only what later tables need; creates nothing domain-specific.
-- pgcrypto: digest() for sha256 (blobs, approval payload hashes). gen_random_uuid() is core since PG 13.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
