ALTER TABLE "proposed_actions" ADD COLUMN "refusal_code" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "currency" char(3);--> statement-breakpoint
-- M2-08: audit_log is append-only at the grant level too. The app connects as the table owner (Render) or a
-- superuser (local, CI). Revoking from the owner makes UPDATE/DELETE/TRUNCATE fail with "permission denied"
-- for a non-superuser owner, and the 0002 trigger still refuses them for a superuser. A purge (M4-07) must
-- re-grant inside its own transaction, explicitly.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM CURRENT_USER;
