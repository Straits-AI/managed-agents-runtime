-- First-class runtime artifacts. These are immutable execution outputs with
-- content identity and producer lineage; they are not Kertas Releases.

CREATE TABLE artifacts (
  id                    TEXT PRIMARY KEY,
  schema_version        INT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  producer_run_id       TEXT NOT NULL REFERENCES runs(id),
  producer_attempt_id   TEXT NOT NULL,
  producer_step         INT NOT NULL CHECK (producer_step >= 0),
  digest                TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  mime_type             TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 255),
  size_bytes            BIGINT NOT NULL CHECK (size_bytes >= 0),
  logical_role          TEXT NOT NULL CHECK (length(logical_role) BETWEEN 1 AND 128),
  source_path           TEXT NOT NULL CHECK (length(source_path) BETWEEN 1 AND 1024),
  source_refs           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_refs) = 'array'),
  verification_refs     JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(verification_refs) = 'array'),
  evidence_refs         JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence_refs) = 'array'),
  object_key            TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (producer_run_id, source_path),
  FOREIGN KEY (producer_attempt_id, producer_run_id)
    REFERENCES run_attempts(id, run_id)
);

CREATE INDEX artifacts_by_run ON artifacts (producer_run_id, created_at, id);
CREATE INDEX artifacts_by_digest ON artifacts (digest);

CREATE TRIGGER artifacts_immutable
  BEFORE UPDATE OR DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
