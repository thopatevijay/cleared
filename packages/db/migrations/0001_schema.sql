CREATE TYPE "public"."action_kind" AS ENUM('add_tracking', 'provide_evidence', 'provide_supporting_info', 'accept_claim');--> statement-breakpoint
CREATE TYPE "public"."action_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."action_state" AS ENUM('proposed', 'approved', 'rejected', 'executing', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('seller', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."draft_state" AS ENUM('draft_ready', 'approved', 'filed');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('scope', 'delivery', 'communication', 'shipment', 'invoice', 'scope_snapshot', 'client_ack');--> statement-breakpoint
CREATE TYPE "public"."hold_state" AS ENUM('open', 'explained', 'action_proposed', 'approved', 'filed', 'released', 'still_held');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'hi');--> statement-breakpoint
CREATE TYPE "public"."pack_state" AS ENUM('empty', 'collecting', 'checked', 'ready', 'stale');--> statement-breakpoint
CREATE TYPE "public"."paypal_resource_type" AS ENUM('order', 'capture', 'dispute');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('seller', 'demo');--> statement-breakpoint
CREATE TYPE "public"."sync_source" AS ENUM('webhook', 'poll');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('met', 'partial', 'missing', 'unverifiable');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('received', 'processed', 'quarantined', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('seller', 'demo');--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"sent_via" text,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"kind" "session_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"locale" "locale" DEFAULT 'en' NOT NULL,
	"timezone" text NOT NULL,
	"base_currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_ip_hash" text,
	"llm_budget_usd" numeric
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_id" uuid NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_sha256" char(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"paypal_status" text,
	"paypal_debug_id" text,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "proposed_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"state" "action_state" DEFAULT 'proposed' NOT NULL,
	"risk" "action_risk" NOT NULL,
	"created_by_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"task" text NOT NULL,
	"input_hash" char(64),
	"model" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"state" "draft_state" DEFAULT 'draft_ready' NOT NULL,
	"notes" text NOT NULL,
	"evidence_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"compiled_blob_id" uuid,
	"sha256" char(64),
	CONSTRAINT "dispute_drafts_notes_length" CHECK (char_length("dispute_drafts"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispute_id" text NOT NULL,
	"payment_id" uuid,
	"reason" text,
	"stage" text,
	"status" text NOT NULL,
	"seller_response_due_date" timestamp with time zone,
	"outcome" jsonb,
	"allowed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paypal_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumer_receipts" (
	"consumer" text NOT NULL,
	"message_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY("consumer","message_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"session_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"response_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("session_id","route","key")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "paypal_resource_owner" (
	"resource_type" "paypal_resource_type" NOT NULL,
	"resource_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_resource_owner_pkey" PRIMARY KEY("resource_type","resource_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"raw" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "webhook_event_status" DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"correlation_id" text,
	"quarantine_reason" text
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explanations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hold_id" uuid NOT NULL,
	"locale" "locale" NOT NULL,
	"text" text NOT NULL,
	"source_ref" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"state" "hold_state" DEFAULT 'open' NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"estimated_release_at" timestamp with time zone,
	"estimate_source" text
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"capture_id" text NOT NULL,
	"order_id" text,
	"amount" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"receivable_amount" numeric,
	"receivable_currency" char(3),
	"status" text NOT NULL,
	"status_reason" text,
	"source" "sync_source" NOT NULL,
	"paypal_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"sha256" char(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_acks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"blob_id" uuid,
	"sha256" char(64) NOT NULL,
	"text" text
);
--> statement-breakpoint
CREATE TABLE "extracted_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"facts" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "proof_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"state" "pack_state" DEFAULT 'empty' NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scope_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_id" uuid NOT NULL,
	"line" text NOT NULL,
	"verdict" "verdict" NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_proposed_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."proposed_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_action_id_proposed_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."proposed_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD CONSTRAINT "dispute_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD CONSTRAINT "dispute_drafts_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_drafts" ADD CONSTRAINT "dispute_drafts_compiled_blob_id_blobs_id_fk" FOREIGN KEY ("compiled_blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_resource_owner" ADD CONSTRAINT "paypal_resource_owner_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_pack_id_proof_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."proof_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_pack_id_proof_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."proof_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_evidence_item_id_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_packs" ADD CONSTRAINT "proof_packs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_packs" ADD CONSTRAINT "proof_packs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD CONSTRAINT "scope_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_checks" ADD CONSTRAINT "scope_checks_pack_id_proof_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."proof_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "magic_links_token_hash_key" ON "magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_links_workspace_created_idx" ON "magic_links" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_workspace_created_idx" ON "notifications" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_workspace_created_idx" ON "sessions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_workspace_created_idx" ON "users" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspaces_created_at_idx" ON "workspaces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workspaces_created_ip_hash_idx" ON "workspaces" USING btree ("created_ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "approvals_action_idx" ON "approvals" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "approvals_workspace_created_idx" ON "approvals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "executions_idempotency_key_key" ON "executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "executions_action_idx" ON "executions" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "executions_workspace_created_idx" ON "executions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "proposed_actions_workspace_created_idx" ON "proposed_actions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_created_idx" ON "agent_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_cache_idx" ON "agent_runs" USING btree ("workspace_id","task","input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_step_key" ON "agent_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_steps_workspace_created_idx" ON "agent_steps" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "dispute_drafts_dispute_idx" ON "dispute_drafts" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "dispute_drafts_workspace_created_idx" ON "dispute_drafts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_dispute_id_key" ON "disputes" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "disputes_payment_idx" ON "disputes" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "disputes_workspace_created_idx" ON "disputes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "paypal_resource_owner_workspace_created_idx" ON "paypal_resource_owner" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "explanations_hold_idx" ON "explanations" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "explanations_workspace_created_idx" ON "explanations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "holds_payment_idx" ON "holds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "holds_workspace_created_idx" ON "holds" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_capture_id_key" ON "payments" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "payments_workspace_created_idx" ON "payments" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "blobs_sha256_idx" ON "blobs" USING btree ("workspace_id","sha256");--> statement-breakpoint
CREATE INDEX "blobs_workspace_created_idx" ON "blobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_acks_token_hash_key" ON "client_acks" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "client_acks_workspace_created_idx" ON "client_acks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_items_pack_idx" ON "evidence_items" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "evidence_items_workspace_created_idx" ON "evidence_items" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "extracted_facts_evidence_item_idx" ON "extracted_facts" USING btree ("evidence_item_id");--> statement-breakpoint
CREATE INDEX "extracted_facts_workspace_created_idx" ON "extracted_facts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_packs_payment_id_key" ON "proof_packs" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "proof_packs_workspace_created_idx" ON "proof_packs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "scope_checks_pack_idx" ON "scope_checks" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "scope_checks_workspace_created_idx" ON "scope_checks" USING btree ("workspace_id","created_at");