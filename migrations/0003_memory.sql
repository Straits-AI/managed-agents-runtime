-- Phase 2: long-term agent memory (memo §9.3). Semantic/episodic facts that
-- persist ACROSS runs — user preferences, decisions, conventions. This is NOT
-- authoritative execution state (that stays in run_events); memory is what the
-- agent "may remember", recalled into context and written via the `remember`
-- tool. Provider-neutral: this is the local (Postgres) adapter's backing store;
-- an AgentKit Memory adapter implements the same MemoryProvider interface.

CREATE TABLE agent_memory (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'fact',   -- fact | preference | decision | episodic
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  run_id      TEXT,                            -- the run that wrote it (provenance)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Full-text search vector maintained by trigger, for recall ranking.
  search_tsv  TSVECTOR
);

CREATE INDEX agent_memory_scope_idx ON agent_memory (tenant_id, agent_id, created_at DESC);
CREATE INDEX agent_memory_tsv_idx ON agent_memory USING GIN (search_tsv);

CREATE FUNCTION agent_memory_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_memory_tsv_trg
  BEFORE INSERT OR UPDATE ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION agent_memory_tsv_update();
