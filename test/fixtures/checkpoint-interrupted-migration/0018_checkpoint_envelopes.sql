-- Deliberately interrupted copy of migration 0018. The migration runner must
-- roll the schema change back atomically and leave it eligible for a clean retry.
ALTER TABLE checkpoints
  ADD COLUMN schema_version INT NOT NULL DEFAULT 1
    CHECK (schema_version >= 1);

SELECT 1 / 0;
