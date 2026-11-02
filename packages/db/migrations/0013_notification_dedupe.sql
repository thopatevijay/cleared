-- M3-08: notifications dedupe on (workspace, kind, ref_id, threshold) instead of (dispute_id, kind), so a
-- renewed due date alerts again (BL-01 6536548146); template data and the email result are stored.
-- Rows written by M2-06 are renamed to the M3-08 kinds and keyed on their dispute (threshold `legacy`).
DROP INDEX "notifications_dispute_kind_key";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_status" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_id" text;--> statement-breakpoint
UPDATE "notifications" SET "kind" = CASE "kind"
  WHEN 'dispute_deadline_72h' THEN 'deadline_t72'
  WHEN 'dispute_deadline_24h' THEN 'deadline_t24'
  ELSE "kind" END;--> statement-breakpoint
UPDATE "notifications" SET
  "ref_type" = CASE WHEN "dispute_id" IS NULL THEN NULL ELSE 'dispute' END,
  "ref_id" = "dispute_id",
  "dedupe_key" = "kind" || ':' || coalesce("dispute_id"::text, "id"::text) || ':legacy';--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "dedupe_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("workspace_id","dedupe_key");
