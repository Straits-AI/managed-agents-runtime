-- A logical action may require a fresh approval after its original approval
-- expires. Preserve one immutable credential-use receipt per approval decision
-- instead of attributing the new release to the stale approval.
DROP INDEX credential_use_receipts_logical_use;

CREATE UNIQUE INDEX credential_use_receipts_logical_use
  ON credential_use_receipts (
    grant_id,
    run_id,
    idempotency_key,
    COALESCE(approval_id, '')
  );
