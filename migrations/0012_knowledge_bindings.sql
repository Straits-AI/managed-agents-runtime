-- Authoritative tenant-owned knowledge bindings. Agent versions refer only to
-- the logical name; provider project/collection identifiers never come from a
-- tenant request or model-controlled tool argument.
CREATE TABLE knowledge_bindings (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  name                 TEXT NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN ('agentkit')),
  provider_project     TEXT NOT NULL,
  provider_collection  TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  live_verified_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, provider, provider_project, provider_collection)
);

CREATE INDEX knowledge_bindings_tenant
  ON knowledge_bindings (tenant_id, status, name);
