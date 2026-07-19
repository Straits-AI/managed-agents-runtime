-- One durable reservation per logical run. Creation serializes on the tenant
-- row, checks capacity, inserts the run/workspace/grants, and records this
-- reservation in the same transaction. Terminal transitions release it.
CREATE TABLE run_admissions (
  run_id           TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  kind             TEXT NOT NULL
                   CHECK (kind IN ('direct', 'fork', 'delegated', 'replacement')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'released')),
  reserved_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  released_at      TIMESTAMPTZ,
  release_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, tenant_id) REFERENCES runs(id, tenant_id),
  CHECK (
    (status = 'active' AND released_at IS NULL) OR
    (status = 'released' AND released_at IS NOT NULL)
  )
);

CREATE INDEX run_admissions_active_tenant
  ON run_admissions (tenant_id, status);

-- Upgrade reconciliation: existing non-terminal runs already consume logical
-- capacity, so represent them before new admissions are accepted. A daily-
-- capped tenant cannot be migrated safely if an active run is unbounded or if
-- the aggregate requested budgets already exceed the tenant ceiling. Fail the
-- migration and require the operator to publish finite budgets/cancel excess
-- runs rather than silently creating unenforceable reservations.
-- Block old writers for the complete preflight + backfill transaction so a run
-- cannot commit between validation and reservation insertion.
-- EXCLUSIVE also conflicts with ROW SHARE from SELECT ... FOR UPDATE. A weaker
-- lock could allow a live transition to hold a run row, wait on run_events,
-- and deadlock this migration while it builds the usage index.
LOCK TABLE runs IN EXCLUSIVE MODE;

-- Admission checks aggregate today's model usage while holding the tenant
-- serialization lock. Build this only after blocking legacy run writers: doing
-- it first could lock run_events while a createRun transaction owns runs and
-- waits to append RunCreated, producing a migration lock cycle.
CREATE INDEX run_events_model_usage_created
  ON run_events (created_at, run_id)
  WHERE type = 'ModelInvocationCompleted';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenants t
    WHERE t.daily_token_budget IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM runs unbounded
          WHERE unbounded.tenant_id = t.id
            AND unbounded.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
            AND unbounded.token_budget IS NULL
        )
        OR
        COALESCE((
          SELECT SUM(
            COALESCE((e.payload->'usage'->>'inputTokens')::bigint, 0) +
            COALESCE((e.payload->'usage'->>'outputTokens')::bigint, 0)
          )
          FROM run_events e
          JOIN runs used_run ON used_run.id = e.run_id
          WHERE used_run.tenant_id = t.id
            AND e.type = 'ModelInvocationCompleted'
            AND e.created_at >=
                (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
            AND e.created_at <
                (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                + interval '1 day'
        ), 0)
        + COALESCE((
          SELECT SUM(GREATEST(active.token_budget - active.tokens_used, 0))
          FROM runs active
          WHERE active.tenant_id = t.id
            AND active.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
        ), 0)
        > t.daily_token_budget
      )
  ) THEN
    RAISE EXCEPTION
      'run admission migration blocked: active daily-capped runs need finite aggregate token budgets within the tenant quota';
  END IF;
END $$;

INSERT INTO run_admissions (run_id, tenant_id, kind, reserved_tokens)
SELECT r.id,
       r.tenant_id,
       CASE
         WHEN r.replaces_run_id IS NOT NULL THEN 'replacement'
         WHEN r.parent_run_id IS NOT NULL THEN 'delegated'
         WHEN r.forked_from_run_id IS NOT NULL THEN 'fork'
         ELSE 'direct'
       END,
       COALESCE(r.token_budget, 0)
FROM runs r
WHERE r.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

-- Keep rolling deployments safe after the table lock is released. A legacy
-- binary may have queued an INSERT behind the migration lock; this deferred
-- trigger lets the current create path insert the run first and its admission
-- later in the same transaction, but rejects any non-terminal run that reaches
-- commit without an active reservation.
CREATE OR REPLACE FUNCTION require_run_admission() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM runs r
    WHERE r.id = NEW.id
      AND r.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
      AND NOT EXISTS (
        SELECT 1 FROM run_admissions a
        WHERE a.run_id = r.id
          AND a.tenant_id = r.tenant_id
          AND a.status = 'active'
      )
  ) THEN
    RAISE EXCEPTION 'non-terminal run % requires an active admission', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER runs_require_admission
  AFTER INSERT ON runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_run_admission();
