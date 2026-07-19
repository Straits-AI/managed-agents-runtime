-- Delegated/forked/replacement runs must never inherit the legacy `default`
-- tenant implicitly, and their lineage must remain inside one tenant even when
-- rows are created outside the TypeScript scheduler.

ALTER TABLE runs ALTER COLUMN tenant_id DROP DEFAULT;

ALTER TABLE runs
  ADD CONSTRAINT runs_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  ADD CONSTRAINT runs_id_tenant_key UNIQUE (id, tenant_id),
  ADD CONSTRAINT runs_parent_same_tenant
  FOREIGN KEY (parent_run_id, tenant_id) REFERENCES runs(id, tenant_id),
  ADD CONSTRAINT runs_replacement_same_tenant
  FOREIGN KEY (replaces_run_id, tenant_id) REFERENCES runs(id, tenant_id),
  ADD CONSTRAINT runs_fork_same_tenant
  FOREIGN KEY (forked_from_run_id, tenant_id) REFERENCES runs(id, tenant_id);
