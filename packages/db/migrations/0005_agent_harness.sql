CREATE TABLE "platform_flags" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"agent_kill_switch" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_flags_single_row" CHECK ("platform_flags"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "kind" text DEFAULT 'call' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "correlation_id" text;