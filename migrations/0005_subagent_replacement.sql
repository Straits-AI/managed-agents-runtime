-- Subagent replacement (memo §25, Phase 5B). When a delegated child run fails,
-- the parent-wake logic replaces it with a fresh child for the same subtask,
-- bounded by a generation cap, before the parent resumes. A replacement child
-- points at the failed child it supersedes and records its generation.
ALTER TABLE runs
  ADD COLUMN replaces_run_id        TEXT REFERENCES runs(id),
  ADD COLUMN replacement_generation INT NOT NULL DEFAULT 0;

-- Fast "is this child superseded by a replacement?" lookups during wake.
CREATE INDEX runs_replaces ON runs (replaces_run_id);
