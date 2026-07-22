-- kertas.runtime/v1alpha1 ManagedSession storage. Historical Runs remain
-- unassigned: continuity cannot be reconstructed safely from existing rows.
CREATE TABLE managed_sessions (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id),
  principal_id             TEXT NOT NULL,
  agent_version_id         TEXT NOT NULL REFERENCES agent_versions(id),
  objective                TEXT NOT NULL,
  correlation_ref          TEXT,
  state                    TEXT NOT NULL DEFAULT 'IDLE'
                           CHECK (state IN (
                             'IDLE', 'ACTIVE', 'WAITING', 'REQUIRES_ACTION',
                             'CANCELLED', 'ARCHIVED'
                           )),
  version                  BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  policy                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  credential_grant_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_top_level_run_id TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE INDEX managed_sessions_tenant_updated
  ON managed_sessions (tenant_id, updated_at DESC, id);

CREATE TABLE session_command_receipts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  principal_id     TEXT NOT NULL,
  operation        TEXT NOT NULL,
  target_scope     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  request_digest   TEXT NOT NULL,
  session_id       TEXT REFERENCES managed_sessions(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, principal_id, operation, target_scope, idempotency_key)
);

CREATE OR REPLACE FUNCTION enforce_session_agent_tenant() RETURNS trigger AS $$
DECLARE
  agent_tenant TEXT;
BEGIN
  SELECT ad.tenant_id INTO agent_tenant
  FROM agent_versions av
  JOIN agent_definitions ad ON ad.id = av.agent_id
  WHERE av.id = NEW.agent_version_id;
  IF agent_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'managed session agent version must belong to the same tenant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER managed_sessions_agent_tenant_guard
  BEFORE INSERT OR UPDATE OF tenant_id, agent_version_id ON managed_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_session_agent_tenant();

ALTER TABLE runs
  ADD COLUMN managed_session_id TEXT REFERENCES managed_sessions(id);

CREATE INDEX runs_managed_session_created
  ON runs (managed_session_id, created_at, id)
  WHERE managed_session_id IS NOT NULL;

CREATE UNIQUE INDEX runs_one_active_top_level_per_session
  ON runs (managed_session_id)
  WHERE managed_session_id IS NOT NULL
    AND parent_run_id IS NULL
    AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

ALTER TABLE managed_sessions
  ADD CONSTRAINT managed_sessions_current_run_fk
  FOREIGN KEY (current_top_level_run_id)
  REFERENCES runs(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION enforce_run_session_lineage() RETURNS trigger AS $$
DECLARE
  parent_session TEXT;
  session_tenant TEXT;
  session_state TEXT;
BEGIN
  IF NEW.managed_session_id IS NOT NULL THEN
    SELECT tenant_id, state INTO session_tenant, session_state
    FROM managed_sessions WHERE id = NEW.managed_session_id
    FOR KEY SHARE;
    IF session_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'run managed session must belong to the same tenant';
    END IF;
    IF session_state IN ('CANCELLED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'managed session does not accept runs in state %', session_state;
    END IF;
  END IF;
  IF NEW.parent_run_id IS NOT NULL THEN
    SELECT managed_session_id INTO parent_session FROM runs WHERE id = NEW.parent_run_id;
    IF NEW.managed_session_id IS DISTINCT FROM parent_session THEN
      RAISE EXCEPTION 'child run managed session must match its parent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER runs_session_lineage_guard
  BEFORE INSERT OR UPDATE OF parent_run_id, managed_session_id ON runs
  FOR EACH ROW EXECUTE FUNCTION enforce_run_session_lineage();
