-- M2-04: scope checks are versioned and append-only. Rows written before this migration exist only in test
-- graphs (nothing wrote scope_checks in the product before M2-04); they are backfilled as version 1 of a
-- `legacy` check, one line per row, before the columns become NOT NULL.
ALTER TABLE "scope_checks" ADD COLUMN "check_version" integer;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "evidence_set_hash" char(64);--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "line_id" text;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "line_citation" jsonb;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "model_verdict" "verdict";--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD COLUMN "rationale" text;--> statement-breakpoint
UPDATE "scope_checks" SET "check_version" = 1, "evidence_set_hash" = repeat('0', 64), "prompt_version" = 'legacy', "line_id" = "id"::text, "model_verdict" = "verdict", "rationale" = '';--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "check_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "evidence_set_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "prompt_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "line_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "model_verdict" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ALTER COLUMN "rationale" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD CONSTRAINT "scope_checks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scope_checks_idempotency_key" ON "scope_checks" USING btree ("pack_id","evidence_set_hash","prompt_version","line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_checks_version_line_key" ON "scope_checks" USING btree ("pack_id","check_version","line_id");--> statement-breakpoint
CREATE TRIGGER scope_checks_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON scope_checks
  FOR EACH STATEMENT EXECUTE FUNCTION cleared_append_only();
