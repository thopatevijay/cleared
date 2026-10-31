DROP INDEX "extracted_facts_evidence_item_idx";--> statement-breakpoint
-- M2-03: rows written before this migration (test graphs only) are extract@v1; the default is dropped after the backfill.
ALTER TABLE "extracted_facts" ADD COLUMN "prompt_version" text DEFAULT 'extract@v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "extracted_facts" ALTER COLUMN "prompt_version" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "extracted_facts_item_prompt_key" ON "extracted_facts" USING btree ("evidence_item_id","prompt_version");
