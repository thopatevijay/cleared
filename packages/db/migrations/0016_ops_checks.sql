-- M3-09: ops_checks (reconcile tick, SLO checks, synthetic judge-path timings) and the synthetic workspace flag.
CREATE TABLE "ops_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check" text NOT NULL,
	"value" numeric,
	"target" numeric,
	"pass" boolean NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "ops_checks_check_run_at_idx" ON "ops_checks" USING btree ("check","run_at");