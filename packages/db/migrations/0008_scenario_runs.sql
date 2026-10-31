CREATE TABLE "scenario_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'judge_dispute' NOT NULL,
	"state" text DEFAULT 'capturing' NOT NULL,
	"order_id" text,
	"capture_id" text,
	"dispute_id" text,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"poll_started_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"polls" integer DEFAULT 0 NOT NULL,
	"decision_requested_at" timestamp with time zone,
	"decision_sent_at" timestamp with time zone,
	"decision_error" text,
	"finished_at" timestamp with time zone,
	"failure" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_runs_state_check" CHECK ("scenario_runs"."state" in ('capturing','seeding','charging_back','polling','resolved','timed_out','failed'))
);
--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scenario_runs_one_active_key" ON "scenario_runs" USING btree ("workspace_id") WHERE "scenario_runs"."state" in ('capturing','seeding','charging_back','polling');--> statement-breakpoint
CREATE INDEX "scenario_runs_workspace_created_idx" ON "scenario_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "scenario_runs_dispute_idx" ON "scenario_runs" USING btree ("dispute_id");