-- Global (cross-instance) rate limiting. The in-process limiter bounds a single
-- API node; this shared bucket table lets multiple API instances enforce one
-- per-tenant limit together (RATE_LIMIT_SCOPE=global). One row per tenant,
-- updated atomically per request.
CREATE TABLE rate_buckets (
  tenant_id  TEXT PRIMARY KEY,
  tokens     DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
