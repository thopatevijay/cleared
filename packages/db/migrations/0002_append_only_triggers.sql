-- M1-02: audit_log and evidence_items are append-only. Grants alone are not enough on Render, where the
-- app connects as the database owner, so BEFORE triggers raise on UPDATE, DELETE and TRUNCATE.
-- Statement-level: the error fires even when the statement matches zero rows.
CREATE OR REPLACE FUNCTION cleared_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION cleared_append_only();
--> statement-breakpoint
CREATE TRIGGER evidence_items_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION cleared_append_only();
