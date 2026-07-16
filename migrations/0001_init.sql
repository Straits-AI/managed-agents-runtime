-- Phase 1 durable state plane (memo §8, §11, §18, §19).

CREATE TABLE agent_definitions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable execution configuration (memo §8.2). Enforced both in code
-- (no UPDATE path) and by trigger below.
CREATE TABLE agent_versions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agent_definitions(id),
  version           INT  NOT NULL,
  instructions      TEXT NOT NULL,
  model_policy      JSONB NOT NULL,
  tool_policy       JSONB NOT NULL DEFAULT '{}',
  skill_refs        JSONB NOT NULL DEFAULT '[]',
  mcp_toolset_refs  JSONB NOT NULL DEFAULT '[]',
  sandbox_spec      JSONB NOT NULL DEFAULT '{}',
  context_strategy  JSONB NOT NULL DEFAULT '{}',
  verifier_policy   JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_versions_immutable
  BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  agent_version_id   TEXT NOT NULL REFERENCES agent_versions(id),
  parent_run_id      TEXT REFERENCES runs(id),  -- always NULL in Phase 1
  goal               TEXT NOT NULL,
  input              JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL,
  status_reason      TEXT,
  progress           JSONB NOT NULL DEFAULT '{}',
  workspace_id       TEXT,
  current_attempt_id TEXT,
  last_event_seq     BIGINT NOT NULL DEFAULT 0,
  max_steps          INT NOT NULL DEFAULT 50,
  token_budget       BIGINT,
  tokens_used        BIGINT NOT NULL DEFAULT 0,
  debug_fault_points JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_claimable ON runs (status, updated_at);

-- Append-only, per-run gapless sequence (memo §11).
CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        BIGINT NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  attempt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TRIGGER run_events_append_only
  BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE run_attempts (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs(id),
  attempt_no                  INT NOT NULL,
  worker_id                   TEXT NOT NULL,
  state                       TEXT NOT NULL, -- ACTIVE | EXITED | ORPHANED
  lease_expires_at            TIMESTAMPTZ NOT NULL,
  heartbeat_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  sandbox_id                  TEXT,
  sandbox_domain              TEXT,
  started_from_checkpoint_id  TEXT,
  exit_reason                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt_no)
);
CREATE INDEX attempts_lease ON run_attempts (state, lease_expires_at);

CREATE TABLE workspaces (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  head_revision_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable tarball snapshots stored in TOS (memo §15).
CREATE TABLE workspace_revisions (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id),
  parent_revision_id     TEXT REFERENCES workspace_revisions(id),
  tos_key                TEXT NOT NULL,
  digest                 TEXT NOT NULL,
  size_bytes             BIGINT,
  created_by_attempt_id  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkpoints (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(id),
  attempt_id             TEXT NOT NULL REFERENCES run_attempts(id),
  event_seq              BIGINT NOT NULL, -- state covers events <= seq
  workspace_revision_id  TEXT REFERENCES workspace_revisions(id),
  progress               JSONB NOT NULL DEFAULT '{}',
  agent_state            JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX checkpoints_by_run ON checkpoints (run_id, event_seq DESC);

-- Durable receipts for external side effects (memo §18).
CREATE TABLE tool_receipts (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  attempt_id       TEXT NOT NULL REFERENCES run_attempts(id),
  step             INT NOT NULL,
  semantic_action  TEXT NOT NULL,
  request_digest   TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  approval_id      TEXT,
  status           TEXT NOT NULL, -- PENDING | COMMITTED | FAILED | NEEDS_RECONCILIATION
  external_txn_id  TEXT,
  result_digest    TEXT,
  result           JSONB,
  reversibility    TEXT NOT NULL DEFAULT 'unknown',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (run_id, idempotency_key)
);

CREATE TABLE approvals (
  id                       TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(id),
  requested_by_attempt_id  TEXT REFERENCES run_attempts(id),
  action                   JSONB NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|DENIED|EXPIRED
  decision_by              TEXT,
  decided_at               TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending ON approvals (run_id, status);

-- Static per-run capability policy (memo §19, reduced for Phase 1).
CREATE TABLE capability_grants (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  action_pattern     TEXT NOT NULL,
  resource_pattern   TEXT NOT NULL DEFAULT '*',
  requires_approval  BOOLEAN NOT NULL DEFAULT false,
  max_calls          INT,
  calls_used         INT NOT NULL DEFAULT 0,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX grants_by_run ON capability_grants (run_id);

-- Transactional outbox (memo §11). Phase 1 publishes in-process.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
