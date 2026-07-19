-- Delegated/forked/replacement runs must never inherit the legacy `default`
-- tenant implicitly, and their lineage must remain inside one tenant even when
-- rows are created outside the TypeScript scheduler.

ALTER TABLE runs ALTER COLUMN tenant_id DROP DEFAULT;

-- Repair only the historical scheduler signature: a child whose agent version
-- belongs to the parent's tenant but whose run was silently assigned another
-- tenant. Repeat because an affected child may itself have affected children.
-- Ambiguous/caller-created mismatches are deliberately left for validation to
-- reject rather than guessing ownership.
DO $$
DECLARE
  repaired BIGINT;
BEGIN
  LOOP
    UPDATE runs AS child
       SET tenant_id = parent.tenant_id
      FROM runs AS parent,
           agent_versions AS version,
           agent_definitions AS definition
     WHERE child.parent_run_id = parent.id
       AND child.tenant_id = 'default'
       AND parent.tenant_id <> 'default'
       AND version.id = child.agent_version_id
       AND definition.id = version.agent_id
       AND definition.tenant_id = parent.tenant_id;
    GET DIAGNOSTICS repaired = ROW_COUNT;
    EXIT WHEN repaired = 0;
  END LOOP;
END $$;

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
