-- Multi-tenancy fix: agent names were globally UNIQUE, so two tenants could not
-- both have an agent with the same name (and one tenant could probe another's
-- names by collision). Scope uniqueness to the owning tenant instead.
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_name_key;
ALTER TABLE agent_definitions
  ADD CONSTRAINT agent_definitions_tenant_name_key UNIQUE (tenant_id, name);
