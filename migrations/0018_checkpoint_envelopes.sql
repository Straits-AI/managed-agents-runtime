-- Version checkpoint payloads without rewriting existing rows. Historical rows
-- are version 1 and upgraded in memory; all new runtime writes use version 2.

ALTER TABLE checkpoints
  ADD COLUMN schema_version INT NOT NULL DEFAULT 1
    CHECK (schema_version >= 1);

CREATE INDEX checkpoints_by_schema_version
  ON checkpoints (schema_version, run_id, event_seq DESC);
