-- Credential escrow / brokering (memo §9.5, §19 layer 5). Per-tenant scoped
-- credentials, encrypted at rest (AES-256-GCM), released to a run's outbound
-- tool call only after verifying tenant + action + resource + expiry + call
-- limit — and injected into the tool adapter, never the model context.
CREATE TABLE credentials (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  action_pattern    TEXT NOT NULL,
  resource_pattern  TEXT NOT NULL DEFAULT '*',
  header_name       TEXT NOT NULL,      -- e.g. 'Authorization'
  secret_ct         TEXT NOT NULL,      -- AES-256-GCM ciphertext (base64)
  iv                TEXT NOT NULL,
  auth_tag          TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,
  max_uses          INT,
  uses              INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credentials_tenant ON credentials (tenant_id);
