-- M3-06: client acknowledgement links. A link is bound to one scope evidence item and its sha256, expires
-- (30 days or the workspace expiry), can be revoked, and points at the `client_ack` evidence item it wrote.
-- No code wrote `client_acks` before this ticket, so the NOT NULL columns are added to an empty table.
-- `rate_limit_hits` counts attempts on the public accept route per hashed IP and per token hash.
CREATE TABLE "rate_limit_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_acks" ADD COLUMN "scope_item_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "client_acks" ADD COLUMN "scope_sha256" char(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "client_acks" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "client_acks" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_acks" ADD COLUMN "evidence_item_id" uuid;--> statement-breakpoint
CREATE INDEX "rate_limit_hits_bucket_at_idx" ON "rate_limit_hits" USING btree ("bucket","at");--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_scope_item_id_evidence_items_id_fk" FOREIGN KEY ("scope_item_id") REFERENCES "public"."evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_evidence_item_id_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_acks_pack_created_idx" ON "client_acks" USING btree ("pack_id","created_at");--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_final_once" CHECK ("client_acks"."accepted_at" is null or "client_acks"."revoked_at" is null);--> statement-breakpoint
ALTER TABLE "client_acks" ADD CONSTRAINT "client_acks_accepted_complete" CHECK (("client_acks"."accepted_at" is null) = ("client_acks"."evidence_item_id" is null));