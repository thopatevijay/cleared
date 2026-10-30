ALTER TABLE "magic_links" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "requested_ip_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "locale" "locale";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "response_status" integer;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "response_body" jsonb;--> statement-breakpoint
CREATE INDEX "magic_links_email_created_idx" ON "magic_links" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "magic_links_ip_created_idx" ON "magic_links" USING btree ("requested_ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_email_lower" CHECK ("magic_links"."email" = lower("magic_links"."email"));