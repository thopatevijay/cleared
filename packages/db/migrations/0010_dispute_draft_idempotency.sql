-- M2-07: a dispute draft records what it was drafted from (pack, scope check version, filing action, run) and
-- is unique per (dispute, check version, action), so a re-delivered trigger finds its row. The columns are
-- nullable for rows written before M2-07 (test stand-ins); NULLs never collide in a unique index.
ALTER TABLE "dispute_drafts" ADD COLUMN "pack_id" uuid;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "check_version" integer;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "action_kind" "action_kind";--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "evidence_type" text;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "reason_unmapped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "fact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD COLUMN "proposed_action_id" uuid;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD CONSTRAINT "dispute_drafts_pack_id_proof_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."proof_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD CONSTRAINT "dispute_drafts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_drafts_idempotency_key" ON "dispute_drafts" USING btree ("dispute_id","check_version","action_kind");