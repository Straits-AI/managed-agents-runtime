-- Multi-tenancy & authorization (memo §19 layer 1 "human and tenant identity",
-- Phase 2 "tenant quotas" + "cost attribution"). Until now the API used a single
-- shared bearer token with no per-tenant scoping — any token holder could read
-- any run. This introduces real tenant identity backed by hashed API keys, plus
-- per-tenant quotas enforced at run creation.

CREATE TABLE tenants (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  -- Quotas. NULL means unlimited.
  max_concurrent_runs  INT,
  daily_token_budget   BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  -- Only a SHA-256 hash of the key is stored; the plaintext is shown once at
  -- creation and never persisted or logged.
  key_hash     TEXT NOT NULL UNIQUE,
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_tenant ON api_keys (tenant_id);

-- A built-in tenant so existing single-token deployments keep working: the
-- configured API_AUTH_TOKEN authenticates as this tenant.
INSERT INTO tenants (id, name) VALUES ('default', 'Default tenant');

-- Tenant-scoped listing and concurrent-run quota checks.
CREATE INDEX runs_tenant ON runs (tenant_id, created_at);
