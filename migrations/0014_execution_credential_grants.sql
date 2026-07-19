-- Credentials are inert vault entries. A separate durable grant binds secret
-- release to an execution subject and records every consumption without secret
-- material.
ALTER TABLE credentials
  ADD CONSTRAINT credentials_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE run_attempts
  ADD CONSTRAINT run_attempts_id_run_unique UNIQUE (id, run_id);

ALTER TABLE approvals
  ADD CONSTRAINT approvals_id_run_unique UNIQUE (id, run_id);

CREATE TABLE credential_grants (
  id                    TEXT PRIMARY KEY,
  credential_id         TEXT NOT NULL,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  agent_version_id      TEXT NOT NULL REFERENCES agent_versions(id),
  run_id                TEXT NOT NULL,
  caller_pattern        TEXT NOT NULL,
  purpose_pattern       TEXT NOT NULL,
  action_pattern        TEXT NOT NULL,
  resource_pattern      TEXT NOT NULL DEFAULT '*',
  requires_approval     BOOLEAN NOT NULL DEFAULT false,
  allow_delegated_runs  BOOLEAN NOT NULL DEFAULT false,
  allow_forks           BOOLEAN NOT NULL DEFAULT false,
  max_uses              INT CHECK (max_uses IS NULL OR max_uses > 0),
  uses                  INT NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at            TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'revoked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (credential_id, tenant_id)
    REFERENCES credentials(id, tenant_id),
  FOREIGN KEY (run_id, tenant_id)
    REFERENCES runs(id, tenant_id)
);

CREATE INDEX credential_grants_active_tenant
  ON credential_grants (tenant_id, status, created_at);
CREATE INDEX credential_grants_run ON credential_grants (run_id);

CREATE FUNCTION enforce_credential_grant_subject() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM runs r
    WHERE r.id = NEW.run_id
      AND r.tenant_id = NEW.tenant_id
      AND r.agent_version_id = NEW.agent_version_id
  ) THEN
    RAISE EXCEPTION 'credential grant execution subject mismatch';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.credential_id, NEW.tenant_id, NEW.agent_version_id, NEW.run_id,
      NEW.caller_pattern, NEW.purpose_pattern, NEW.action_pattern,
      NEW.resource_pattern, NEW.requires_approval, NEW.allow_delegated_runs,
      NEW.allow_forks, NEW.max_uses, NEW.expires_at
    ) IS DISTINCT FROM ROW(
      OLD.credential_id, OLD.tenant_id, OLD.agent_version_id, OLD.run_id,
      OLD.caller_pattern, OLD.purpose_pattern, OLD.action_pattern,
      OLD.resource_pattern, OLD.requires_approval, OLD.allow_delegated_runs,
      OLD.allow_forks, OLD.max_uses, OLD.expires_at
    ) THEN
      RAISE EXCEPTION 'credential grant policy is immutable';
    END IF;
    IF NEW.uses < OLD.uses THEN
      RAISE EXCEPTION 'credential grant uses cannot decrease';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'credential grant revocation is irreversible';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_grants_subject_guard
  BEFORE INSERT OR UPDATE ON credential_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_credential_grant_subject();

CREATE TABLE credential_use_receipts (
  id             TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),
  attempt_id     TEXT NOT NULL,
  approval_id    TEXT,
  idempotency_key TEXT NOT NULL,
  caller         TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (grant_id, tenant_id)
    REFERENCES credential_grants(id, tenant_id),
  FOREIGN KEY (credential_id, tenant_id)
    REFERENCES credentials(id, tenant_id),
  FOREIGN KEY (run_id, tenant_id)
    REFERENCES runs(id, tenant_id),
  FOREIGN KEY (attempt_id, run_id)
    REFERENCES run_attempts(id, run_id),
  FOREIGN KEY (approval_id, run_id)
    REFERENCES approvals(id, run_id)
);

CREATE UNIQUE INDEX credential_use_receipts_logical_use
  ON credential_use_receipts (grant_id, run_id, idempotency_key);

CREATE INDEX credential_use_receipts_run
  ON credential_use_receipts (run_id, created_at);

CREATE FUNCTION reject_credential_use_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credential use receipts are immutable';
END;
$$;

CREATE TRIGGER credential_use_receipts_no_update
  BEFORE UPDATE OR DELETE ON credential_use_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_credential_use_receipt_mutation();
