CREATE TYPE "public"."deadline_state" AS ENUM('ok', 't72', 't24', 'closed_for_action');--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dispute_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "deadline_state" "deadline_state" DEFAULT 'ok' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dispute_kind_key" ON "notifications" USING btree ("dispute_id","kind");