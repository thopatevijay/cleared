-- BL-01 6570499264 (ADR 0017 addendum 3): the seller's goods/service declaration on a hold (Cleared's own field, never a PayPal state).
ALTER TABLE "holds" ADD COLUMN "seller_declared_kind" text;--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "seller_declared_by" text;--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "seller_declared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_seller_declared_kind" CHECK ("holds"."seller_declared_kind" is null or "holds"."seller_declared_kind" in ('goods', 'service'));--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_seller_declared_complete" CHECK (("holds"."seller_declared_kind" is null) = ("holds"."seller_declared_by" is null) and ("holds"."seller_declared_kind" is null) = ("holds"."seller_declared_at" is null));