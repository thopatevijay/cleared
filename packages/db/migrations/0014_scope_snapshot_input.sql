-- M3-07: a scope snapshot is idempotent on (pack, input hash): the hash of everything it prints except
-- generated_at (ADR 0018). Null for every other item; Postgres treats nulls as distinct, so they never collide.
ALTER TABLE "evidence_items" ADD COLUMN "input_sha256" char(64);--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_items_pack_input_key" ON "evidence_items" USING btree ("pack_id","input_sha256");