-- Run forking (memo §20 POST /v1/runs/{id}/fork): branch a new run from a
-- source run's checkpoint + workspace. A distinct lineage from parent_run_id
-- (delegation) and replaces_run_id (replacement).
ALTER TABLE runs ADD COLUMN forked_from_run_id TEXT REFERENCES runs(id);
CREATE INDEX runs_forked_from ON runs (forked_from_run_id);
