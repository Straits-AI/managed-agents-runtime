-- Phase 2: AgentKit Knowledge (memo §9.4) — enterprise retrieval (RAG) over
-- documents. Provider-neutral: this is the local (Postgres full-text) adapter's
-- store; an AgentKit Knowledge Base adapter implements the same KnowledgeProvider.

-- Which knowledge base an agent version retrieves from.
ALTER TABLE agent_versions ADD COLUMN knowledge_config JSONB NOT NULL DEFAULT '{}';

CREATE TABLE knowledge_docs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT 'default',
  knowledge_base_id TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_tsv        TSVECTOR
);

CREATE INDEX knowledge_docs_kb_idx ON knowledge_docs (tenant_id, knowledge_base_id);
CREATE INDEX knowledge_docs_tsv_idx ON knowledge_docs USING GIN (search_tsv);

CREATE FUNCTION knowledge_docs_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_docs_tsv_trg
  BEFORE INSERT OR UPDATE ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION knowledge_docs_tsv_update();
