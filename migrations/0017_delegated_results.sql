-- Bounded structured Run results used by delegated-child projections. Results
-- are durable execution truth; artifact bytes/metadata remain in artifacts.

ALTER TABLE runs
  ADD COLUMN result JSONB,
  ADD COLUMN result_size_bytes INT
    CHECK (result_size_bytes IS NULL OR result_size_bytes BETWEEN 0 AND 65536);

ALTER TABLE runs
  ADD CONSTRAINT run_result_pair CHECK (
    (result IS NULL AND result_size_bytes IS NULL)
    OR (result IS NOT NULL AND result_size_bytes IS NOT NULL)
  );

ALTER TABLE runs
  ADD CONSTRAINT run_result_encoded_bound CHECK (
    result IS NULL OR octet_length(result::text) <= 65536
  );

-- A failed generation may have at most one replacement. This makes selected
-- generation resolution deterministic even under concurrent workers.
CREATE UNIQUE INDEX runs_one_replacement
  ON runs (replaces_run_id)
  WHERE replaces_run_id IS NOT NULL;

CREATE INDEX runs_child_lineage
  ON runs (parent_run_id, replacement_generation, created_at, id)
  WHERE parent_run_id IS NOT NULL;
