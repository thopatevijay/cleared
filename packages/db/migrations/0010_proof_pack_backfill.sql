-- M2-05 (BL-01 6536606046): every payment has its proof pack. From now on the capture sync creates the
-- pack (state `empty`) in the transaction that first stores the payment; this backfills payments stored
-- before that. `proof_packs_payment_id_key` keeps it one pack per payment, so a re-run inserts nothing.
INSERT INTO "proof_packs" ("workspace_id", "payment_id")
SELECT "workspace_id", "id" FROM "payments"
ON CONFLICT ("payment_id") DO NOTHING;
