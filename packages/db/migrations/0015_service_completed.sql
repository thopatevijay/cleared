-- M3-04: the secondary API record is a new action kind; the guided web step stores the seller's date.
ALTER TYPE "public"."action_kind" ADD VALUE 'record_service_completed';--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "completed_confirmed_at" timestamp with time zone;