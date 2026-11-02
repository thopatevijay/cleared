-- M3-10 (ADR 0019): the review-hold pool and the ownership transfer column.
CREATE TABLE "review_hold_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"pool_workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"state" text DEFAULT 'awaiting_buyer' NOT NULL,
	"amount" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"approve_url" text NOT NULL,
	"capture_id" text,
	"capture_status" text,
	"capture_reason" text,
	"captured_at" timestamp with time zone,
	"assigned_workspace_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_hold_pool_purpose" CHECK ("review_hold_pool"."purpose" in ('judge', 'video')),
	CONSTRAINT "review_hold_pool_state" CHECK ("review_hold_pool"."state" in ('awaiting_buyer', 'held', 'not_held', 'released'))
);
--> statement-breakpoint
ALTER TABLE "paypal_resource_owner" ADD COLUMN "transferred_from" uuid;--> statement-breakpoint
ALTER TABLE "review_hold_pool" ADD CONSTRAINT "review_hold_pool_pool_workspace_id_workspaces_id_fk" FOREIGN KEY ("pool_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_hold_pool" ADD CONSTRAINT "review_hold_pool_assigned_workspace_id_workspaces_id_fk" FOREIGN KEY ("assigned_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_hold_pool_order_id_key" ON "review_hold_pool" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_hold_pool_capture_id_key" ON "review_hold_pool" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "review_hold_pool_assignable_idx" ON "review_hold_pool" USING btree ("purpose","state","captured_at");--> statement-breakpoint
CREATE INDEX "review_hold_pool_assigned_idx" ON "review_hold_pool" USING btree ("assigned_workspace_id");--> statement-breakpoint
ALTER TABLE "paypal_resource_owner" ADD CONSTRAINT "paypal_resource_owner_transferred_from_workspaces_id_fk" FOREIGN KEY ("transferred_from") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;