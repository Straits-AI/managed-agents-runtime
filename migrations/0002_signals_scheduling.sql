-- Phase 2A: external signals + scheduled (delayed-start) runs.

-- A run may wait for a named external signal (RUNNING -> WAITING_SIGNAL),
-- woken by POST /v1/runs/{id}/signals. NULL means the run is not waiting.
ALTER TABLE runs ADD COLUMN awaited_signal TEXT;

-- A scheduled run stays unclaimable until this time (NULL = start immediately).
ALTER TABLE runs ADD COLUMN scheduled_for TIMESTAMPTZ;

-- The scheduler filters on (status, scheduled_for); index the common claim path.
CREATE INDEX runs_claimable_idx ON runs (status, scheduled_for);
